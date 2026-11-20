// End-to-end check of the gateway on throw-away data: the full OAuth flow a ChatGPT/Claude connector performs
// (registration → authorize → owner approval → token with PKCE → MCP search → refresh), plus the refusals.
// Your real base, gateway settings and approvals are not touched. Usage: npm run check:gateway
import {spawn} from 'node:child_process';
import {createHash, randomBytes} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url)), app = path.resolve(here, '..', 'app'), demo = path.resolve(here, '..', 'demo');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'secondbrain-gateway-test-')), home = path.join(tmp, 'home'); fs.mkdirSync(home);
const APP = 8899, GW = 8897, ADMIN = 8896, origin = 'http://127.0.0.1:' + GW, CALLBACK = 'http://127.0.0.1:8790/callback';
fs.writeFileSync(path.join(tmp, 'gateway.json'), JSON.stringify({origin, port: GW, adminPort: ADMIN, brain: 'http://127.0.0.1:' + APP}));
const appEnv = {...process.env, USERPROFILE: home, HOME: home, BRAIN_DB: path.join(tmp, 'brain.sqlite'), BRAIN_PORT: String(APP), BRAIN_CARD_WORKER: 'off', BRAIN_OBSIDIAN_ROOT: path.join(demo, 'notes')};
const gwEnv = {...process.env, GATEWAY_CONFIG: path.join(tmp, 'gateway.json'), GATEWAY_PRIVATE: path.join(tmp, 'private')};
const procs = [], sleep = ms => new Promise(r => setTimeout(r, ms));
const start = (script, env, cwd) => { const p = spawn(process.execPath, [script], {cwd, env, stdio: ['ignore', 'pipe', 'pipe']}); p.log = ''; p.stdout.on('data', d => p.log += d); p.stderr.on('data', d => p.log += d); procs.push(p); return p; };
const up = async url => { for (let i = 0; i < 80; i++) { await sleep(250); if (await fetch(url).then(r => r.ok, () => false)) return true; } return false; };
let failed = 0;
const check = (name, ok, detail = '') => { if (!ok) failed++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail && !ok ? ' — ' + detail : '')); };
const form = o => new URLSearchParams(o).toString();
const b64 = b => b.toString('base64url');

try {
  const a = start(path.join(app, 'server.mjs'), appEnv, app);
  check('SecondBrain запускается', await up('http://127.0.0.1:' + APP + '/api/stats'), a.log);
  const imp = spawn(process.execPath, [path.join(app, 'tools', 'import-export.mjs'), path.join(demo, 'chatgpt-export')], {env: appEnv});
  check('демо-чаты импортированы', await new Promise(r => imp.on('close', r)) === 0);

  const g = start(path.join(here, 'server.mjs'), gwEnv, here);
  check('шлюз запускается', await up(origin + '/healthz'), g.log);
  const adminKey = fs.readFileSync(path.join(tmp, 'private', 'admin-token'), 'utf8');
  const admin = (p, o = {}) => fetch('http://127.0.0.1:' + ADMIN + '/' + p, {...o, headers: {Authorization: 'Bearer ' + adminKey, 'Content-Type': 'application/json', ...(o.headers || {})}});

  const meta = await fetch(origin + '/.well-known/oauth-authorization-server').then(r => r.json());
  check('метаданные OAuth', meta.registration_endpoint === origin + '/register' && meta.code_challenge_methods_supported?.includes('S256'));
  const prm = await fetch(origin + '/.well-known/oauth-protected-resource/mcp').then(r => r.json(), () => ({}));
  check('метаданные ресурса /mcp', prm.resource === origin + '/mcp', JSON.stringify(prm));
  const noToken = await fetch(origin + '/mcp', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{}'});
  check('без токена — 401 и ссылка на авторизацию', noToken.status === 401 && /resource_metadata/.test(noToken.headers.get('www-authenticate') || ''));

  const evil = await fetch(origin + '/register', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({redirect_uris: ['https://evil.example/cb'], token_endpoint_auth_method: 'none'})});
  check('чужой сервис не может зарегистрироваться', evil.status === 400);
  const client = await fetch(origin + '/register', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({redirect_uris: [CALLBACK], token_endpoint_auth_method: 'none', client_name: 'selftest', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code']})}).then(r => r.json());
  check('регистрация клиента', typeof client.client_id === 'string', JSON.stringify(client));

  const verifier = b64(randomBytes(32)), challenge = b64(createHash('sha256').update(verifier).digest());
  const auth = await fetch(origin + '/authorize?' + form({response_type: 'code', client_id: client.client_id, redirect_uri: CALLBACK, code_challenge: challenge, code_challenge_method: 'S256', state: 'st8', resource: origin + '/mcp'}), {redirect: 'manual'});
  const consent = auth.headers.get('location') || '';
  check('запрос доступа ведёт на страницу подтверждения', [302, 303].includes(auth.status) && consent.startsWith('/consent?id='), auth.status + ' ' + consent);
  const waiting = await fetch(origin + consent, {redirect: 'manual'}).then(r => r.text());
  const code = (waiting.match(/<code>(\d{4})<\/code>/) || [])[1];
  check('без подтверждения владельца доступа нет', /npm run gateway:approve/.test(waiting) && !!code);
  const pending = await admin('pending').then(r => r.json());
  check('владелец видит тот же проверочный код', pending.length === 1 && pending[0].check === code);
  check('пульт управления без ключа закрыт', (await fetch('http://127.0.0.1:' + ADMIN + '/pending')).status === 401);
  await admin('approve', {method: 'POST', body: JSON.stringify({id: pending[0].id})});
  const back = await fetch(origin + consent, {redirect: 'manual'});
  const cb = new URL(back.headers.get('location') || 'http://x/');
  check('после подтверждения — возврат в клиент с кодом', back.status === 303 && cb.origin + cb.pathname === CALLBACK && cb.searchParams.get('state') === 'st8' && !!cb.searchParams.get('code'));

  const token = body => fetch(origin + '/token', {method: 'POST', headers: {'Content-Type': 'application/x-www-form-urlencoded'}, body: form(body)});
  const wrong = await token({grant_type: 'authorization_code', code: cb.searchParams.get('code'), redirect_uri: CALLBACK, client_id: client.client_id, code_verifier: b64(randomBytes(32)), resource: origin + '/mcp'});
  check('неверный PKCE отклонён', wrong.status === 400);
  const t1 = await token({grant_type: 'authorization_code', code: cb.searchParams.get('code'), redirect_uri: CALLBACK, client_id: client.client_id, code_verifier: verifier, resource: origin + '/mcp'}).then(r => r.json());
  check('выдан токен доступа', typeof t1.access_token === 'string' && typeof t1.refresh_token === 'string', JSON.stringify(t1));

  const mcp = (body, tok = t1.access_token, extra = {}) => fetch(origin + '/mcp', {method: 'POST', headers: {'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: 'Bearer ' + tok, ...extra}, body: JSON.stringify(body)});
  const init = await mcp({jsonrpc: '2.0', id: 1, method: 'initialize', params: {protocolVersion: '2025-06-18', capabilities: {}, clientInfo: {name: 'selftest', version: '1'}}}).then(r => r.json());
  check('MCP: инструкция «сначала ищи в базе»', /brain_search FIRST/.test(init.result?.instructions || ''), JSON.stringify(init).slice(0, 300));
  const tools = await mcp({jsonrpc: '2.0', id: 2, method: 'tools/list'}).then(r => r.json());
  const names = (tools.result?.tools || []).map(t => t.name).sort().join(',');
  check('MCP: только 3 инструмента чтения', names === 'brain_get_record,brain_overview,brain_search', names);
  const found = await mcp({jsonrpc: '2.0', id: 3, method: 'tools/call', params: {name: 'brain_search', arguments: {query: 'ноутбук'}}}).then(r => r.json());
  const hits = JSON.parse(found.result?.content?.[0]?.text || '{}').results || [];
  check('MCP: поиск через шлюз находит запись', hits[0]?.title === 'Выбор ноутбука для работы', JSON.stringify(found).slice(0, 300));
  check('MCP: запрос с чужого сайта отклонён', (await mcp({jsonrpc: '2.0', id: 4, method: 'tools/list'}, t1.access_token, {Origin: 'https://evil.example'})).status === 403);
  const badHost = await new Promise(res => { import('node:http').then(({default: http}) => { const r = http.request({host: '127.0.0.1', port: GW, path: '/healthz', headers: {Host: 'evil.example'}}, x => { x.resume(); res(x.statusCode); }); r.on('error', () => res(0)); r.end(); }); });
  check('чужой Host отклонён', badHost === 403);

  const t2 = await token({grant_type: 'refresh_token', refresh_token: t1.refresh_token, client_id: client.client_id}).then(r => r.json());
  check('продление токена', typeof t2.access_token === 'string');
  check('старый токен продления больше не работает', (await token({grant_type: 'refresh_token', refresh_token: t1.refresh_token, client_id: client.client_id})).status === 400);
  await admin('revoke-all', {method: 'POST'});
  check('отзыв всех подключений', (await mcp({jsonrpc: '2.0', id: 5, method: 'tools/list'}, t2.access_token)).status === 401);
} catch (e) {
  failed++; console.log('FAIL ' + (e.stack || e.message));
} finally {
  for (const p of procs) p.kill();
  await sleep(800);
  try { fs.rmSync(tmp, {recursive: true, force: true}); } catch {}
  console.log(failed ? `\nИТОГ: ${failed} проверок не прошли` : '\nИТОГ: шлюз работает');
  process.exit(failed ? 1 : 0);
}
