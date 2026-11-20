// npm run gateway:setup                      → берёт адрес этого компьютера из Tailscale
// npm run gateway:setup -- https://mcp.example.ru  → свой домен (VPS за Caddy)
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import {configPath, writeConfig} from './config.mjs';
let origin = process.argv[2];
if (!origin) {
  try {
    const s = JSON.parse(execFileSync('tailscale', ['status', '--json'], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']}));
    const name = String(s.Self?.DNSName || '').replace(/\.$/, '');
    if (!name) throw Error('empty');
    origin = 'https://' + name;
  } catch {
    console.error('Не удалось узнать адрес из Tailscale. Установите и запустите Tailscale или укажите адрес явно:\n  npm run gateway:setup -- https://ваш-адрес');
    process.exit(1);
  }
}
const u = new URL(origin);
if (u.protocol !== 'https:') { console.error('Нужен https-адрес'); process.exit(1); }
const previous = fs.existsSync(configPath()) ? JSON.parse(fs.readFileSync(configPath(), 'utf8')) : {};
writeConfig({...previous, origin: u.origin, port: previous.port || 8787, adminPort: previous.adminPort || 8788, brain: previous.brain || 'http://127.0.0.1:8877'});
console.log('Готово: ' + configPath());
console.log('Публичный адрес коннектора: ' + u.origin + '/mcp');
console.log('\nДальше:\n  1) npm run gateway            (или автозапуск: gateway\Install-Gateway-Startup.ps1)\n  2) tailscale funnel --bg 8787  (только для варианта с Tailscale)\n  3) добавьте коннектор в ChatGPT/Claude и подтвердите: npm run gateway:approve');
