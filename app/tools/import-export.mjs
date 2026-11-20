// Import an official chat export into the running SecondBrain.
//   ChatGPT: Settings → Data controls → Export data → unzip → conversations.json
//   Claude:  Settings → Privacy → Export data → unzip → conversations.json
// Usage: node tools/import-export.mjs <path to conversations.json or the unzipped folder> [chatgpt|claude]
// Re-running is safe: an unchanged conversation is recognised and not duplicated; a changed one becomes a new revision.
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.BRAIN_URL || 'http://127.0.0.1:' + (process.env.BRAIN_PORT || 8877);
const BATCH = 20;

let [input, forced] = process.argv.slice(2);
if (!input) { console.error('Укажите путь: node tools/import-export.mjs <conversations.json или папка выгрузки> [chatgpt|claude]'); process.exit(2); }
if (fs.statSync(input).isDirectory()) input = path.join(input, 'conversations.json');
if (!fs.existsSync(input)) { console.error('Не найден файл ' + input); process.exit(2); }

const data = JSON.parse(fs.readFileSync(input, 'utf8').replace(/^﻿/, ''));
const list = Array.isArray(data) ? data : data.conversations || [];
if (!list.length) { console.error('В файле нет разговоров'); process.exit(1); }
const provider = forced || (list[0].mapping ? 'chatgpt' : list[0].chat_messages ? 'claude' : null);
if (!['chatgpt', 'claude'].includes(provider)) { console.error('Не удалось понять формат. Укажите вторым аргументом chatgpt или claude.'); process.exit(2); }

try { await fetch(BASE + '/api/stats'); } catch { console.error('SecondBrain не запущен на ' + BASE + '. Сначала запустите приложение.'); process.exit(1); }

let imported = 0, changed = 0, failed = 0;
for (let i = 0; i < list.length; i += BATCH) {
  const chunk = list.slice(i, i + BATCH);
  const response = await fetch(BASE + '/api/ingest', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider, connector_id: provider, transport: 'direct-export', data: chunk }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) { failed += chunk.length; console.error('Пакет ' + (i / BATCH + 1) + ': ' + (result.error || response.status)); continue; }
  imported += result.imported || 0; changed += result.changed || 0;
  process.stdout.write(`\r${provider}: обработано ${Math.min(i + BATCH, list.length)} из ${list.length}`);
}
console.log(`\nГотово. Сохранено: ${imported}, новых или изменённых: ${changed}, ошибок: ${failed}.`);
process.exit(failed ? 1 : 0);
