import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {BrainStore} from './store.mjs';
import {ConnectorRegistry} from './connectors/registry.mjs';
import {TelegramBot, messageText, localDay} from './connectors/telegram-bot.mjs';

const TOKEN = '1234567890:AAHfixtureTOKENfixtureTOKENfixture12';
// Fake Bot API: scripted updates and errors, records sent messages. No network.
function fakeTelegram({me = {id: 42, is_bot: true, username: 'demo_brain_bot', can_read_all_group_messages: false}} = {}) {
  const t = {updates: [], sent: [], webhook: '', errors: [], files: {}, calls: [], me};
  t.fetch = async (url, options = {}) => {
    const u = new URL(url), file = u.pathname.match(/^\/file\/bot([^/]+)\/(.+)$/);
    if (file) { const f = t.files[file[2]]; return f ? new Response(f) : new Response('no', {status: 404}); }
    const [, token, method] = u.pathname.match(/^\/bot([^/]+)\/(\w+)$/);
    const p = options.body ? JSON.parse(options.body) : {};
    t.calls.push(method);
    const ok = result => new Response(JSON.stringify({ok: true, result}));
    const err = (code, description, parameters) => new Response(JSON.stringify({ok: false, error_code: code, description, ...(parameters ? {parameters} : {})}));
    if (token !== TOKEN) return err(401, 'Unauthorized');
    if (t.errors.length && t.errors[0].method === method) { const e = t.errors.shift(); return err(e.code, e.description, e.parameters); }
    if (method === 'getMe') return ok(t.me);
    if (method === 'getWebhookInfo') return ok({url: t.webhook});
    if (method === 'deleteWebhook') { t.webhook = ''; return ok(true); }
    if (method === 'sendMessage') { t.sent.push(p); return ok({message_id: 9000 + t.sent.length}); }
    if (method === 'getFile') { const size = p.file_id === 'big' ? 30 * 1024 * 1024 : 5; return ok({file_id: p.file_id, file_size: size, file_path: 'docs/' + p.file_id + '.txt'}); }
    if (method === 'getUpdates') { if (t.webhook) return err(409, 'Conflict: can\'t use getUpdates method while webhook is active'); return ok(t.updates.filter(x => x.update_id >= (p.offset || 0))); }
    return err(400, 'unknown method');
  };
  return t;
}
const DAY1 = 1794700000, DAY2 = DAY1 + 86400 * 2;
const msg = (id, chat, text, extra = {}) => ({message_id: id, date: DAY1 + id, chat, from: {id: 7, is_bot: false, first_name: 'Тест'}, text, ...extra});
const me = {id: 7, type: 'private', first_name: 'Тест'}, group = {id: -100555, type: 'supergroup', title: 'Входящие'};
function setup(tg = fakeTelegram()) {
  const s = new BrainStore(':memory:'), r = new ConnectorRegistry(s), secretDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-secret-'));
  const assetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-assets-'));
  const bot = new TelegramBot(s, r, {secretDir, assetDir, fetchImpl: tg.fetch, apiBase: 'http://telegram.test'});
  let n = 1; const push = (...updates) => { for (const u of updates) tg.updates.push({update_id: n++, ...u}); };
  return {s, r, bot, tg, push, secretDir};
}
const approveFrom = async (bot, tg, chatId) => { const text = tg.sent.filter(m => m.chat_id === chatId).at(-1).text; return bot.approve(chatId, text.match(/код (\d{6})/)[1]); };
const search = (s, q) => s.search(q).results.map(r => r.title);

test('token: format, 401, webhook conflict and explicit webhook removal; token never reaches the database or status', async () => {
  const {s, r, bot, tg, secretDir} = setup();
  await assert.rejects(bot.saveToken('просто текст'), /не похоже на токен/);
  await assert.rejects(bot.saveToken('1234567890:AAHwrongwrongwrongwrongwrongwrong99'), /Токен не принят/);
  tg.webhook = 'https://other.example/hook';
  await assert.rejects(bot.saveToken(TOKEN), /вебхук/);
  assert.equal(bot.token(), null, 'token is not saved while the bot belongs to another program');
  const st = await bot.saveToken('bot' + TOKEN, {deleteWebhook: true});
  assert.equal(tg.webhook, ''); assert.equal(st.bot.username, 'demo_brain_bot'); assert.equal(r.get('telegram').enabled, true);
  assert.ok(!JSON.stringify(st).includes(TOKEN.split(':')[1]));
  assert.ok(!JSON.stringify(s.db.prepare("SELECT * FROM brain_meta WHERE key LIKE 'telegram:%'").all()).includes(TOKEN.split(':')[1]));
  assert.ok(fs.readFileSync(path.join(secretDir, 'telegram-bot.json'), 'utf8').includes(TOKEN));
  s.close();
});

test('unknown chat: nothing stored, pairing code sent once; wrong code refused; right code connects', async () => {
  const {s, bot, tg, push} = setup();
  await bot.saveToken(TOKEN);
  push({message: msg(1, me, '/start')}, {message: msg(2, me, 'секретная мысль до подтверждения')});
  const r1 = await bot.pollOnce();
  assert.equal(r1.captured, 0); assert.equal(s.db.prepare('SELECT count(*) n FROM telegram_messages').get().n, 0);
  assert.equal(tg.sent.filter(m => m.chat_id === 7).length, 1, 'one code per chat, not one per message');
  assert.equal(bot.status().pending.length, 1);
  await assert.rejects(bot.approve(7, '000000'), /не совпадает/);
  await approveFrom(bot, tg, 7);
  assert.match(tg.sent.at(-1).text, /Чат подключён/);
  assert.deepEqual(bot.status().allowed.map(c => c.id), ['7']);
  assert.deepEqual(search(s, 'секретная мысль'), [], 'messages sent before approval are not stored');
  s.close();
});

test('approved chat: text, forwarded origin, caption + file, big file, edits, two days, /status; restart does not duplicate', async () => {
  const tg = fakeTelegram(), {s, r, bot, push, secretDir} = setup(tg);
  tg.files['docs/doc1.txt'] = Buffer.from('файл с текстом');
  await bot.saveToken(TOKEN); push({message: msg(1, me, '/start')}); await bot.pollOnce(); await approveFrom(bot, tg, 7);
  push(
    {message: msg(10, me, 'Решили запускать пилот в декабре')},
    {message: msg(11, me, 'Цена согласована, 500 рублей за штуку', {forward_origin: {type: 'user', date: DAY1 - 3600, sender_user: {id: 99, first_name: 'Мария', last_name: 'Петрова'}}})},
    {message: msg(12, me, undefined, {caption: 'Договор поставки', document: {file_id: 'doc1', file_name: 'договор.txt', mime_type: 'text/plain', file_size: 5}})},
    {message: msg(13, me, undefined, {caption: 'Большое видео', document: {file_id: 'big', file_name: 'видео.mp4', file_size: 30 * 1024 * 1024}})},
    {message: {...msg(14, me, 'Второй день: обсудили логотип'), date: DAY2}},
    {message: msg(15, me, '/status')},
  );
  const r1 = await bot.pollOnce();
  assert.equal(r1.captured, 5); assert.equal(r1.changed, 2);
  const day1 = s.db.prepare("SELECT * FROM sources WHERE provider='telegram' ORDER BY source_date").all();
  assert.equal(day1.length, 2); assert.match(day1[0].title, /^Telegram · Тест · /);
  assert.deepEqual(search(s, 'пилот декабре'), [day1[0].title]);
  const body = s.detail(day1[0].id).body;
  assert.match(body, /Переслано от: Мария Петрова/); assert.match(body, /\[файл: договор\.txt\]/); assert.match(body, /файл не сохранён: видео\.mp4 — больше 20 МБ/);
  assert.equal(s.db.prepare('SELECT count(*) n FROM assets WHERE source_id=?').get(day1[0].id).n, 1);
  assert.match(tg.sent.at(-1).text, /сохранено сообщений/);
  const rev = day1[0].revision;
  push({edited_message: {...msg(10, me, 'Решили запускать пилот в январе'), edit_date: DAY1 + 100}});
  await bot.pollOnce();
  const after = s.db.prepare('SELECT revision FROM sources WHERE id=?').get(day1[0].id).revision;
  assert.notEqual(after, rev); assert.deepEqual(search(s, 'пилот январе'), [day1[0].title]); assert.deepEqual(search(s, 'пилот декабре'), []);
  // restart: a new instance continues from the saved offset; nothing is re-read or duplicated
  const again = new TelegramBot(s, r, {secretDir, assetDir: bot.assetDir, fetchImpl: tg.fetch, apiBase: 'http://telegram.test'});
  const r2 = await again.pollOnce();
  assert.equal(r2.updates, 0); assert.equal(s.db.prepare("SELECT count(*) n FROM sources WHERE provider='telegram'").get().n, 2);
  s.close();
});

test('groups: privacy-mode warning, supergroup migration keeps approval, removal of the bot is reported, data stays', async () => {
  const {s, bot, tg, push} = setup();
  await bot.saveToken(TOKEN);
  const small = {id: -555, type: 'group', title: 'Входящие'};
  push({message: msg(1, small, 'привет бот')}); await bot.pollOnce(); await approveFrom(bot, tg, -555);
  assert.match(bot.status().warnings.join(' '), /setprivacy/);
  push({message: msg(2, small, undefined, {migrate_to_chat_id: -100555})}, {message: msg(3, group, 'после миграции идея про лендинг')});
  await bot.pollOnce();
  assert.deepEqual(bot.status().allowed.map(c => c.id), ['-100555']); assert.equal(search(s, 'миграции лендинг').length, 1);
  push({my_chat_member: {chat: group, from: {id: 7}, date: DAY1, old_chat_member: {status: 'member'}, new_chat_member: {status: 'kicked', user: {id: 42}}}});
  await bot.pollOnce();
  assert.equal(bot.status().removed[0].id, '-100555'); assert.equal(search(s, 'миграции лендинг').length, 1);
  s.close();
});

test('errors: 409 second reader, 429 retry-after, network failure; disabled connector does not poll', async () => {
  const {s, r, bot, tg} = setup();
  await bot.saveToken(TOKEN);
  tg.errors.push({method: 'getUpdates', code: 409, description: 'Conflict: terminated by other getUpdates request; make sure that only one bot instance is running'});
  await assert.rejects(bot.pollOnce(), e => /только один читатель/.test(e.message) && e.conflict === 'polling');
  assert.match(bot.status().last_error.message, /один читатель/);
  tg.errors.push({method: 'getUpdates', code: 429, description: 'Too Many Requests: retry after 7', parameters: {retry_after: 7}});
  await assert.rejects(bot.pollOnce(), e => e.retryAfter === 7);
  const offline = new TelegramBot(s, r, {secretDir: bot.secretDir, fetchImpl: async () => { throw Object.assign(new Error('fetch failed'), {cause: {code: 'ECONNRESET'}}); }, apiBase: 'http://telegram.test'});
  await assert.rejects(offline.pollOnce(), /Нет связи с api\.telegram\.org \(ECONNRESET\).*VPN/);
  r.configure('telegram', {enabled: false}); tg.calls.length = 0;
  assert.equal((await bot.pollOnce()).skipped, 'disabled'); assert.ok(!tg.calls.includes('getUpdates'));
  s.close();
});

test('Telegram Desktop export merges with bot messages of the same chat and day; repeat import changes nothing', async () => {
  const {s, r, bot, tg, push} = setup();
  await bot.saveToken(TOKEN); push({message: msg(1, group, 'привет')}); await bot.pollOnce(); await approveFrom(bot, tg, -100555);
  push({message: msg(20, group, 'живое сообщение через бота')}); await bot.pollOnce();
  const exp = {name: 'Входящие', type: 'private_supergroup', id: 555, messages: [
    {id: 5, type: 'message', date: '2026-11-15T10:00:00', date_unixtime: String(DAY1 + 5), from: 'Мария', text: ['старая ', {type: 'bold', text: 'договорённость'}, ' про скидку']},
    {id: 6, type: 'service', date_unixtime: String(DAY1 + 6), action: 'pin_message'},
    {id: 7, type: 'message', date_unixtime: String(DAY1 + 7), from: 'Тест', forwarded_from: 'Поставщик', text: '', file: 'files/прайс.pdf', media_type: 'document'}]};
  const r1 = bot.importExport(exp);
  assert.equal(r1.messages, 2); assert.equal(r1.skipped, 1);
  const rec = s.db.prepare("SELECT id FROM sources WHERE provider='telegram'").all();
  assert.equal(rec.length, 1, 'export and bot messages of one day share one record');
  const body = s.detail(rec[0].id).body;
  assert.match(body, /старая договорённость про скидку/); assert.match(body, /живое сообщение через бота/); assert.match(body, /Переслано от: Поставщик/); assert.match(body, /прайс\.pdf/);
  assert.equal(bot.importExport(exp).records_changed, 0);
  assert.throws(() => bot.importExport({foo: 1}), /не выгрузка Telegram/);
  s.close();
});

test('message text helpers: hidden forward, channel origin, location, poll; local day boundaries', () => {
  assert.match(messageText({forward_origin: {type: 'hidden_user', sender_user_name: 'Аноним'}, text: 'x'}), /Переслано от: Аноним/);
  assert.match(messageText({forward_origin: {type: 'channel', chat: {title: 'Новости'}}, text: 'x'}), /Переслано от: Новости/);
  assert.match(messageText({location: {latitude: 55.7, longitude: 37.6}}), /геопозиция 55\.7, 37\.6/);
  assert.match(messageText({poll: {question: 'Когда?', options: [{text: 'Пн'}, {text: 'Вт'}]}}), /опрос: Когда\? — Пн \/ Вт/);
  assert.equal(localDay(Date.UTC(2026, 10, 20, 22, 30) / 1000, 'Europe/Moscow'), '2026-11-21');
  assert.equal(localDay(Date.UTC(2026, 10, 20, 22, 30) / 1000, 'UTC'), '2026-11-20');
});

test('live loop: polls while enabled, records errors with back-off, waits when the token is missing, stops cleanly', async () => {
  const {startTelegramLoop} = await import('./connectors/telegram-bot.mjs');
  const {s, r, bot, tg, push} = setup();
  const waits = [], sleep = async ms => { waits.push(ms); await new Promise(res => setImmediate(res)); };
  let stop = startTelegramLoop(bot, {sleep});
  await new Promise(res => setTimeout(res, 20));
  assert.ok(waits.length && waits.every(w => w === 5000), 'no token: idle checks only, no Telegram calls');
  assert.equal(tg.calls.length, 0); stop();
  await bot.saveToken(TOKEN); push({message: msg(1, me, 'hi')});
  tg.errors.push({method: 'getUpdates', code: 429, description: 'Too Many Requests', parameters: {retry_after: 3}});
  waits.length = 0; stop = startTelegramLoop(bot, {sleep});
  await new Promise(res => setTimeout(res, 50)); stop();
  assert.ok(waits.includes(3000), 'Retry-After is honoured');
  assert.ok(tg.calls.filter(c => c === 'getUpdates').length >= 2, 'polling resumes after the pause');
  assert.ok(tg.sent.some(m => /код \d{6}/.test(m.text)), 'pairing message sent by the loop');
  r.configure('telegram', {enabled: false});
  s.close();
});
