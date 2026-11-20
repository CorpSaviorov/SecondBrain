// End-to-end check on a throw-away database: start the server, import the demo export, search through MCP.
// Your real base (store/brain.sqlite) and your real chats are not touched: a temporary home folder and DB are used.
// Usage: node app/tools/demo-check.mjs        → prints PASS/FAIL for each step, exit code 0 when everything passes.
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const demo = path.resolve(app, '..', 'demo');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'secondbrain-demo-'));
const home = path.join(tmp, 'home'); fs.mkdirSync(home);
const port = 8899, base = 'http://127.0.0.1:' + port;
const env = {...process.env, USERPROFILE: home, HOME: home, BRAIN_DB: path.join(tmp, 'brain.sqlite'), BRAIN_PORT: String(port),
  BRAIN_CARD_WORKER: 'off', BRAIN_OBSIDIAN_ROOT: path.join(demo, 'notes')};
const server = spawn(process.execPath, [path.join(app, 'server.mjs')], {cwd: app, env, stdio: ['ignore', 'pipe', 'pipe']});
let log = ''; server.stdout.on('data', d => log += d); server.stderr.on('data', d => log += d);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const post = (p, b) => fetch(base + p, {method: 'POST', headers: {'Content-Type': 'application/json', Accept: 'application/json'}, body: JSON.stringify(b)}).then(r => r.json());
const mcp = async (name, args) => JSON.parse((await post('/mcp', {jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name, arguments: args}})).result.content[0].text);
let failed = 0;
const check = (name, ok, detail = '') => { if (!ok) failed++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' — ' + detail : '')); };

try {
  let up = false;
  for (let i = 0; i < 80 && !up; i++) { await sleep(250); up = await fetch(base + '/api/stats').then(r => r.ok, () => false); }
  check('сервер запускается', up, up ? base : log.slice(-500));
  if (!up) throw Error('server did not start');

  const imp = spawn(process.execPath, [path.join(app, 'tools', 'import-export.mjs'), path.join(demo, 'chatgpt-export')], {env});
  const code = await new Promise(r => imp.on('close', r));
  check('импорт выгрузки ChatGPT', code === 0);

  await post('/api/sync', {}); await sleep(3000);
  const stats = await fetch(base + '/api/stats').then(r => r.json());
  check('в базе 3 чата и 1 заметка', stats.providers.some(p => p.provider === 'chatgpt' && p.count === 3) && stats.providers.some(p => p.provider === 'obsidian' && p.count === 1), JSON.stringify(stats.providers));

  const tools = (await post('/mcp', {jsonrpc: '2.0', id: 1, method: 'tools/list'})).result.tools.map(t => t.name);
  check('MCP отдаёт 3 инструмента', ['brain_overview', 'brain_search', 'brain_get_record'].every(t => tools.includes(t)), tools.join(', '));

  const s1 = await mcp('brain_search', {query: 'ноутбук'});
  check('поиск по чату: «ноутбук»', s1.results[0]?.title === 'Выбор ноутбука для работы', s1.results.map(r => r.title).join(' | '));
  const s2 = await mcp('brain_search', {query: 'ваниль'});
  check('поиск по чату: «ваниль»', s2.results[0]?.title === 'Рецепт сырников');
  const s3 = await mcp('brain_search', {query: 'идеи канала'});
  check('поиск по заметке: «идеи канала»', s3.results[0]?.title === 'Идеи для канала');
  const rec = await mcp('brain_get_record', {id: s1.results[0]?.id});
  check('чтение записи', JSON.stringify(rec).includes('32 ГБ'));
  const page = await fetch(base + '/').then(r => r.status);
  check('веб-панель открывается', page === 200);
} catch (e) {
  if (!failed) { failed++; console.log('FAIL ' + e.message); }
} finally {
  server.kill(); await sleep(800);
  try { fs.rmSync(tmp, {recursive: true, force: true}); } catch {}
  console.log(failed ? `\nИТОГ: ${failed} проверок не прошли` : '\nИТОГ: всё работает');
  process.exit(failed ? 1 : 0);
}
