import fs from 'node:fs';
import path from 'node:path';
import {setImmediate} from 'node:timers/promises';
import {sourceDates,resolvedDate} from '../lib/ranking.mjs';
import {json} from '../store.mjs';
function* walk(root,relative=''){
 for(const entry of fs.readdirSync(root,{withFileTypes:true})){
  if(entry.name.startsWith('.')||entry.isSymbolicLink())continue;
  const rel=relative?relative+'/'+entry.name:entry.name,absolute=path.join(root,entry.name);
  if(entry.isDirectory())yield* walk(absolute,rel);else if(entry.isFile()&&entry.name.toLowerCase().endsWith('.md'))yield {rel,absolute};
 }
}
export async function collect(store,connector,{signal,isEnabled}){
 const root=connector.config.root;if(typeof root!=='string'||!fs.existsSync(root))throw Error('Папка источника недоступна. Остальные подключения продолжают работать.');
 const key='files:'+connector.id,old=store.db.prepare('SELECT payload FROM connector_state WHERE id=?').get(key),checkpoint=old?JSON.parse(old.payload):{},result={changed:0,unchanged:0,errors:[]};let seen=0;
 for(const {rel,absolute}of walk(root)){
  if(!isEnabled())break;
  try{
   const before=fs.statSync(absolute),signature=[before.size,before.mtimeMs,before.ctimeMs].join(':');
   if(checkpoint[rel]===signature){result.unchanged++;continue;}
   if(before.size>64_000_000)throw Error('Source exceeds the configured 64 MB limit');
   const bytes=fs.readFileSync(absolute),after=fs.statSync(absolute);if(before.size!==after.size||before.mtimeMs!==after.mtimeMs)throw Error('Source changed while reading');
   const body=bytes.toString('utf8'),values={},front=body.match(/^---\r?\n([\s\S]*?)\r?\n---/);
   for(const line of (front?.[1]||'').split(/\r?\n/)){const m=line.match(/^([\w-]+):\s*["']?([^\r\n]*?)["']?$/);if(m)values[m[1]]=m[2];}
   const title=values.title||body.match(/^#\s+(.+)$/m)?.[1]||path.basename(rel,'.md'),date=resolvedDate({source_dates:sourceDates({source:rel.includes('/wiki/')?'wiki':'note',filename:path.basename(rel),body,values})},Date.now());
   const r=store.ingest({provider:connector.provider,account:connector.id===connector.provider?'personal':connector.id,external_id:rel,kind:rel.includes('/wiki/')?'wiki':'note',title,messages:[{id:'note',role:'note',text:body}],body,source_path:rel,source_date:date?.value,date_basis:date?.basis,coverage:{saved_text:true},metadata:{connector_id:connector.id}},{raw:bytes,transport:'direct-note-connector'});
   if(r.changed)result.changed++;checkpoint[rel]=signature;
  }catch(e){result.errors.push({path:rel,error:e.message});}
  if(++seen%30===0)await setImmediate();
 }
 store.state(key,'ready',checkpoint);return result;
}
