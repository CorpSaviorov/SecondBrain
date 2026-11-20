// Import an official export into the running SecondBrain.
//   ChatGPT:  Settings → Data controls → Export data → unzip → conversations.json
//   Claude:   Settings → Privacy → Export data → unzip → conversations.json
//   Telegram: Telegram Desktop → chat → ⋮ → Export chat history → format JSON → result.json
//             (or Settings → Advanced → Export Telegram data → JSON → result.json with all chats)
// Usage: node tools/import-export.mjs <file or unzipped folder> [chatgpt|claude|telegram]
// Re-running is safe: unchanged items are recognised and not duplicated; changed ones become a new revision.
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.BRAIN_URL || 'http://127.0.0.1:' + (process.env.BRAIN_PORT || 8877);
const BATCH = 20, TG_BATCH = 500;

let [input, forced] = process.argv.slice(2);
if (!input) { console.error('Укажите путь: node tools/import-export.mjs <conversations.json, result.json или папка выгрузки> [chatgpt|claude|telegram]'); process.exit(2); }
if (!fs.existsSync(input)) { console.error('Не найден путь ' + input); process.exit(2); }
if (fs.statSync(input).isDirectory()) {
  const found = ['conversations.json', 'result.json'].map(f => path.join(input, f)).find(f => fs.existsSync(f));
  if (!found) { console.error('В папке нет conversations.json (ChatGPT/Claude) или result.json (Telegram)'); process.exit(2); }
  input = found;
}

let data;
try { data = JSON.parse(fs.readFileSync(input, 'utf8').replace(/^﻿/, '')); }
catch (e) { console.error('Файл не читается как JSON: ' + e.message + '. Для Telegram выберите формат «JSON», а не HTML.'); process.exit(2); }

try { await fetch(BASE + '/api/stats'); } catch { console.error('SecondBrain не запущен на ' + BASE + '. Сначала запустите приложение.'); process.exit(1); }
const post = async (route, body) => { const r = await fetch(BASE + route, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)}); const v = await r.json().catch(() => ({})); if (!r.ok) throw Error(v.error || 'HTTP ' + r.status); return v; };

const telegramChats = Array.isArray(data?.chats?.list) ? data.chats.list : Array.isArray(data?.messages) && !Array.isArray(data) ? [data] : null;
if (forced === 'telegram' || (!forced && telegramChats)) {
  if (!telegramChats) { console.error('Это не выгрузка Telegram Desktop: нет поля messages'); process.exit(2); }
  let messages = 0, records = 0, failed = 0;
  for (const chat of telegramChats) {
    const list = Array.isArray(chat.messages) ? chat.messages : [];
    for (let i = 0; i < list.length; i += TG_BATCH) {
      try { const r = await post('/api/telegram/import', {data: {id: chat.id, type: chat.type, name: chat.name, messages: list.slice(i, i + TG_BATCH)}}); messages += r.messages; records += r.records_changed; }
      catch (e) { failed++; console.error(`\n${chat.name || chat.id}: ${e.message}`); if (/включите источник Telegram/.test(e.message)) process.exit(1); }
      process.stdout.write(`\rTelegram: «${chat.name || chat.id}» ${Math.min(i + TG_BATCH, list.length)} из ${list.length}`);
    }
  }
  console.log(`\nГотово. Сообщений сохранено: ${messages}, записей (чат × день) создано или обновлено: ${records}, ошибок: ${failed}.`);
  process.exit(failed ? 1 : 0);
}

const list = Array.isArray(data) ? data : data.conversations || [];
if (!list.length) { console.error('В файле нет разговоров'); process.exit(1); }
const provider = forced || (list[0].mapping ? 'chatgpt' : list[0].chat_messages ? 'claude' : null);
if (!['chatgpt', 'claude'].includes(provider)) { console.error('Не удалось понять формат. Укажите вторым аргументом chatgpt, claude или telegram.'); process.exit(2); }

let imported = 0, changed = 0, failed = 0;
for (let i = 0; i < list.length; i += BATCH) {
  const chunk = list.slice(i, i + BATCH);
  try { const r = await post('/api/ingest', {provider, connector_id: provider, transport: 'direct-export', data: chunk}); imported += r.imported || 0; changed += r.changed || 0; }
  catch (e) { failed += chunk.length; console.error('\nПакет ' + (i / BATCH + 1) + ': ' + e.message); }
  process.stdout.write(`\r${provider}: обработано ${Math.min(i + BATCH, list.length)} из ${list.length}`);
}
console.log(`\nГотово. Сохранено: ${imported}, новых или изменённых: ${changed}, ошибок: ${failed}.`);
process.exit(failed ? 1 : 0);
