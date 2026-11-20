// Gateway settings: gateway/config.json (created by `npm run gateway:setup`), overridable for tests.
//   origin    public HTTPS address that ChatGPT/Claude will use (Tailscale Funnel name or your domain)
//   port      local port the public address forwards to (default 8787)
//   adminPort loopback-only control port for approvals (default 8788, never publish it)
//   brain     the local SecondBrain app (default http://127.0.0.1:8877)
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
export const configPath = () => process.env.GATEWAY_CONFIG || path.join(here, 'config.json');
export const privateDir = () => process.env.GATEWAY_PRIVATE || path.join(here, 'private');
export function loadConfig() {
  const file = configPath();
  if (!fs.existsSync(file)) throw new Error('Нет gateway/config.json. Сначала: npm run gateway:setup');
  const c = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  const u = new URL(c.origin);
  const local = /^(127\.0\.0\.1|localhost)$/.test(u.hostname);
  if (!(u.protocol === 'https:' || (u.protocol === 'http:' && local)) || u.pathname !== '/' || u.search || u.hash) throw new Error('origin должен быть https://адрес без пути, например https://my-pc.tail1234.ts.net');
  return {origin: u.origin, port: Number(c.port || 8787), adminPort: Number(c.adminPort || 8788), brain: String(c.brain || 'http://127.0.0.1:8877').replace(/\/$/, '')};
}
export function writeConfig(value) {
  fs.writeFileSync(configPath(), JSON.stringify(value, null, 2) + '\n');
}
