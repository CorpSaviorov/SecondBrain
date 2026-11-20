// Consistent online copy of the SecondBrain database (SQLite backup API): safe while the server is running.
// Usage: node backup-db.mjs <source brain.sqlite> <destination file>
// Prints JSON: {ok, sources, cards, bytes, integrity}. Never writes to the source.
import {DatabaseSync,backup} from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
const [src,dest]=process.argv.slice(2);
if(!src||!dest)throw Error('usage: node backup-db.mjs <source> <destination>');
if(fs.existsSync(dest))throw Error('destination already exists: '+dest);
fs.mkdirSync(path.dirname(dest),{recursive:true});
const live=new DatabaseSync(src,{readOnly:true});
await backup(live,dest);
const live_sources=live.prepare('SELECT count(*) n FROM sources').get().n;live.close();
const copy=new DatabaseSync(dest,{readOnly:true});
const out={ok:false,sources:copy.prepare('SELECT count(*) n FROM sources').get().n,live_sources,cards:copy.prepare('SELECT count(*) n FROM cards').get().n,bytes:fs.statSync(dest).size,integrity:copy.prepare('PRAGMA quick_check').get().quick_check};
copy.close();out.ok=out.integrity==='ok'&&out.sources>0&&out.sources>=out.live_sources-5;
console.log(JSON.stringify(out));if(!out.ok)process.exit(2);
