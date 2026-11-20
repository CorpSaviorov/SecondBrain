// Owner-side approval of AI connector requests (ChatGPT, Claude). Every request is confirmed by hand.
// npm run gateway:approve   — waits up to 10 minutes; compare the check code with the browser page, then Д/Y to allow.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import {loadConfig, privateDir} from './config.mjs';
const cfg = loadConfig();
const headers = () => ({Authorization: 'Bearer ' + fs.readFileSync(path.join(privateDir(), 'admin-token'), 'utf8'), 'Content-Type': 'application/json'});
const admin = (p, o = {}) => fetch(`http://127.0.0.1:${cfg.adminPort}/${p}`, {headers: headers(), ...o});
const who = cb => /^https:\/\/claude\.(ai|com)\//.test(cb) ? 'Claude' : /^https:\/\/chatgpt\.com\//.test(cb) ? 'ChatGPT' : /^http:\/\/127\.0\.0\.1/.test(cb) ? 'локальный тест' : 'НЕИЗВЕСТНЫЙ сервис (' + cb + ')';
const rl = readline.createInterface({input: process.stdin, output: process.stdout}); let closed = false; rl.on('close', () => { closed = true; });
const ask = async q => { if (closed) return ''; try { return await rl.question(q); } catch { return ''; } };
const seen = new Set(), end = Date.now() + 10 * 60e3; let approved = 0;
console.log('Жду запросы на подключение к SecondBrain (до 10 минут). Нажмите «Connect» в ChatGPT или Claude.');
try {
  while (Date.now() < end) {
    let list = [];
    try { const r = await admin('pending'); if (!r.ok) throw Error('шлюз ответил ' + r.status); list = await r.json(); }
    catch (e) { console.log('Шлюз не отвечает: ' + e.message + '. Запустите: npm run gateway'); break; }
    for (const p of list) {
      if (seen.has(p.id)) continue; seen.add(p.id);
      const a = (await ask(`\nЗапрос от: ${who(p.callback)}\nПроверочный код: ${p.check} (должен совпадать с кодом на странице в браузере)\nРазрешить? (Д/Н): `)).trim().toLowerCase();
      if (['д', 'да', 'y', 'yes'].includes(a)) { const r = await admin('approve', {method: 'POST', body: JSON.stringify({id: p.id})}); console.log(r.ok ? 'Разрешено. Вернитесь в браузер — страница продолжит сама.' : 'Не получилось (' + r.status + '): запрос устарел, нажмите Connect ещё раз.'); if (r.ok) approved++; }
      else console.log('Пропущено.');
    }
    if (approved && !list.length) { const more = (await ask('\nПодключить ещё один сервис? (Д/Н): ')).trim().toLowerCase(); if (!['д', 'да', 'y', 'yes'].includes(more)) break; approved = 0; }
    if (closed) break; await new Promise(r => setTimeout(r, 2000));
  }
} finally { rl.close(); }
console.log('Готово.');
