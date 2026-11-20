// Downloads the Electron binary for the login window (postinstall). Retries, and explains failures instead of a bare
// "command failed" from npm.
const {spawnSync} = require('node:child_process');
const path = require('node:path');
const script = path.join(__dirname, 'node_modules', 'electron', 'install.js');
for (let attempt = 1; attempt <= 3; attempt++) {
  const r = spawnSync(process.execPath, [script], {stdio: ['ignore', 'inherit', 'pipe'], encoding: 'utf8'});
  if (r.status === 0) { console.log('Electron готов.'); process.exit(0); }
  console.error(`Попытка ${attempt}: не удалось скачать Electron.\n${(r.stderr || '').trim().slice(-800)}`);
}
console.error('\nНе удалось скачать окно входа (Electron, ~100 МБ с github.com). Проверьте интернет/VPN и повторите: npm run setup:cloud');
process.exit(1);
