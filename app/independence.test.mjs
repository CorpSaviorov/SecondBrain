import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
test('isolated app boots, reads and searches with no Gateway, Obsidian, legacy service or collectors',async()=>{
 const from=path.dirname(fileURLToPath(import.meta.url)),root=fs.mkdtempSync(path.join(os.tmpdir(),'brain-independent-'));
 for(const file of ['server.mjs','store.mjs','project-groups.mjs','model-provider.mjs','record-view.mjs','card-worker.mjs','card-packets.mjs','billing.mjs','card-output-schema.mjs','formats.mjs','native-read.py','attachment-index.mjs'])fs.copyFileSync(path.join(from,file),path.join(root,file));
 for(const dir of ['lib','connectors','public','python'])fs.cpSync(path.join(from,dir),path.join(root,dir),{recursive:true});
 const child=spawn(process.execPath,[path.join(root,'server.mjs')],{cwd:root,windowsHide:true,env:{...process.env,BRAIN_DB:path.join(root,'standalone.sqlite'),BRAIN_PORT:'0',BRAIN_OBSIDIAN_ROOT:path.join(root,'nonexistent-vault')}});
 try{
  const url=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Standalone start timeout')),10000);child.stdout.on('data',b=>{const m=b.toString().match(/http:\/\/127\.0\.0\.1:\d+/);if(m){clearTimeout(timer);resolve(m[0]);}});child.on('error',reject);child.stderr.on('data',b=>reject(Error(b.toString())));});
  const post=async(p,v)=>{const r=await fetch(url+p,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(v)});assert.equal(r.status,200);return r.json();};
  await post('/api/ingest',{provider:'chatgpt',data:{conversation_id:'independent',title:'Независимая память',messages:[{id:'m1',author:{role:'user'},content:{parts:['Проверка рефакторинга без Obsidian']}}]}});
  const configs=await(await fetch(url+'/api/connectors')).json();
  for(const c of configs.connectors)await post('/api/connectors/'+c.id,{enabled:false});
  const sync=await post('/api/sync',{});assert.ok(sync.results.every(r=>r.skipped==='disabled'));
  assert.equal((await(await fetch(url+'/api/search?q='+encodeURIComponent('рефакторинг'))).json()).total,1);
  const detail=await(await fetch(url+'/api/source?id=chatgpt:independent')).json();assert.ok(detail.body.includes('Проверка'));assert.equal((await(await fetch(url+'/api/graph')).json()).total_sources,1);
  assert.equal((await fetch(url+'/')).status,200);
 }finally{const exited=new Promise(r=>child.once('exit',r));child.kill();await exited;}
});
