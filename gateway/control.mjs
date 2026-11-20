// npm run gateway:status | node gateway/control.mjs revoke-all | shutdown
import fs from 'node:fs';
import path from 'node:path';
import {loadConfig, privateDir} from './config.mjs';
const cfg = loadConfig(), key = fs.readFileSync(path.join(privateDir(), 'admin-token'), 'utf8');
const action = process.argv[2] || 'status';
if (!['status', 'pending', 'revoke-all', 'shutdown'].includes(action)) throw new Error('Действия: status, pending, revoke-all, shutdown');
const r = await fetch('http://127.0.0.1:' + cfg.adminPort + '/' + action, {method: ['revoke-all', 'shutdown'].includes(action) ? 'POST' : 'GET', headers: {Authorization: 'Bearer ' + key}});
console.log(r.status, await r.text());
if (!r.ok) process.exitCode = 1;
