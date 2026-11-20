import http from 'node:http';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
test('direct capture → SQLite → BM25 → bounded MCP; repeats do not duplicate',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'secondbrain-http-test-'));
 const child=spawn(process.execPath,[fileURLToPath(new URL('./server.mjs',import.meta.url))],{env:{...process.env,BRAIN_DB:path.join(dir,'test.sqlite'),BRAIN_PORT:'0'},windowsHide:true});
 try{
  const url=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Server start timeout')),10000);child.stdout.on('data',b=>{const m=b.toString().match(/http:\/\/127\.0\.0\.1:\d+/);if(m){clearTimeout(timer);resolve(m[0]);}});child.on('error',reject);child.stderr.on('data',b=>reject(Error(b.toString())));});
  const post=async(p,v)=>{const r=await fetch(url+p,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(v)});assert.equal(r.status,200);return r.json();};
  const packet={provider:'chatgpt',data:{conversation_id:'fixture',title:'TypeScript — рефакторинг',messages:[{id:'m1',author:{role:'user'},create_time:1794700000,content:{parts:['Вопрос о рефакторинге TypeScript. '.repeat(500)]}}],page_info:{has_previous_page:false}}};
  assert.equal((await post('/api/ingest',packet)).changed,1);assert.equal((await post('/api/ingest',packet)).changed,0);
  assert.equal((await(await fetch(url+'/api/stats')).json()).sources,1);
  const search=await(await fetch(url+'/api/search?q='+encodeURIComponent('рефакторинг TypeScript'))).json();assert.equal(search.total,1);assert.equal(search.model_calls,0);
  assert.equal((await post('/api/ingest',{...packet,data:{...packet.data,page_info:{has_previous_page:true}}})).pending,1);
  const mcp=await post('/mcp',{jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'brain_get_record',arguments:{id:'chatgpt:fixture'}}}),text=mcp.result.content[0].text;
  assert.ok(text.length<=6000);const d=JSON.parse(text);assert.equal(d.next_offset,d.body.length);assert.equal(d.id,'chatgpt:fixture');
  assert.equal((await fetch(url+'/')).status,200);
  const mpost=(v,h={})=>fetch(url+'/mcp',{method:'POST',headers:{'Content-Type':'application/json',...h},body:JSON.stringify(v)});
  assert.equal((await mpost({jsonrpc:'2.0',id:2,method:'ping'})).status,200);assert.deepEqual((await(await mpost({jsonrpc:'2.0',id:3,method:'ping'})).json()).result,{});
  assert.equal((await mpost({jsonrpc:'2.0',id:4,method:'tools/list'},{Origin:'https://evil.example'})).status,403);
  assert.equal((await mpost({jsonrpc:'2.0',id:5,method:'tools/list'},{Origin:'http://localhost:8877'})).status,200);
  assert.equal((await fetch(url+'/mcp')).status,405);
  const init=await(await mpost({jsonrpc:'2.0',id:6,method:'initialize',params:{}})).json();assert.match(init.result.instructions,/brain_overview/);
  const tl=await(await mpost({jsonrpc:'2.0',id:7,method:'tools/list'})).json();assert.equal(tl.result.tools[0].name,'brain_overview');
  const ov=JSON.parse((await(await mpost({jsonrpc:'2.0',id:8,method:'tools/call',params:{name:'brain_overview',arguments:{}}})).json()).result.content[0].text);assert.equal(ov.totals.records,1);assert.ok(Array.isArray(ov.recent)&&ov.recent.length===1);assert.ok(JSON.stringify(ov).length<8000);
  const ov2=JSON.parse((await(await mpost({jsonrpc:'2.0',id:9,method:'tools/call',params:{name:'brain_overview',arguments:{since:'2099-01-01',limit:5}}})).json()).result.content[0].text);assert.equal(ov2.since,'2099-01-01');assert.equal(ov2.recent.length,0);
  const gr=JSON.parse((await(await mpost({jsonrpc:'2.0',id:10,method:'tools/call',params:{name:'brain_get_record',arguments:{id:'chatgpt:fixture'}}})).json()).result.content[0].text);assert.equal(gr.view,'dialogue');assert.match(gr.body,/^\[user/);
  { const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(path.join(dir,'test.sqlite'));db.exec('PRAGMA busy_timeout=5000');const rev=db.prepare('SELECT revision FROM sources WHERE id=?').get('chatgpt:fixture').revision;
   db.prepare('INSERT INTO cards VALUES(?,?,?,?,?,?)').run('chatgpt:fixture',rev,'full',JSON.stringify({title:'Рефакторинг TypeScript',summary:'Обсуждение рефакторинга',items:[{kind:'user_goal',text:'Пользователь хочет провести рефакторинг TypeScript-кода',evidence:[{role:'user',quote:'Вопрос о рефакторинге TypeScript.',time:'2026-11-15T10:00:00Z'}]},{kind:'user_request',text:'Посмотреть сборку проекта',evidence:[]}]}),new Date().toISOString(),'x');db.close(); }
  const sr=JSON.parse((await(await mpost({jsonrpc:'2.0',id:11,method:'tools/call',params:{name:'brain_search',arguments:{query:'рефакторинг TypeScript'}}})).json()).result.content[0].text);
  assert.equal(sr.results[0].atoms.length,1);assert.match(sr.results[0].atoms[0].text,/рефакторинг/);assert.equal(sr.results[0].atoms[0].date,'2026-11-15');assert.equal(sr.results[0].rank_factors,undefined);assert.equal(sr.results[0].summary,'Обсуждение рефакторинга');
  const port=new URL(url).port,raw=(path,headers,method='GET',body)=>new Promise((ok,bad)=>{const r=http.request({host:'127.0.0.1',port,path,method,headers},res=>{res.resume();res.on('end',()=>ok(res));});r.on('error',bad);if(body)r.write(body);r.end();});
  assert.equal((await raw('/api/stats',{Host:'evil.example'})).statusCode,403);
  assert.equal((await raw('/api/processing/run',{Origin:'https://evil.example','Content-Type':'text/plain'},'POST','{}')).statusCode,403);
  assert.equal((await raw('/api/stats',{})).headers['access-control-allow-origin'],undefined);
  const secret='sk-proj-'+'Z9y8X7w6V5u4T3s2R1q0P9o8N7m6';assert.equal((await post('/api/ingest',{provider:'chatgpt',data:{conversation_id:'sec',title:'Ключ',messages:[{id:'s1',author:{role:'user'},create_time:1794700001,content:{parts:['мой ключ '+secret]}}],page_info:{has_previous_page:false}}})).changed,1);
  const rec=await(await fetch(url+'/api/record?id=chatgpt:sec')).text();assert.ok(!rec.includes(secret));assert.ok(rec.includes('[скрыто: ключ OpenAI]'));
 }finally{child.kill();await new Promise(r=>child.once('exit',r));}
});
test('remote access: only the configured public address passes Host/Origin checks; others stay blocked',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'secondbrain-remote-test-'));
 const child=spawn(process.execPath,[fileURLToPath(new URL('./server.mjs',import.meta.url))],{env:{...process.env,BRAIN_DB:path.join(dir,'test.sqlite'),BRAIN_PORT:'0',BRAIN_CARD_WORKER:'off',BRAIN_PUBLIC_ORIGIN:'https://brain.example.test'},windowsHide:true});
 try{
  const url=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Server start timeout')),10000);child.stdout.on('data',b=>{const m=b.toString().match(/http:\/\/127\.0\.0\.1:\d+/);if(m){clearTimeout(timer);resolve(m[0]);}});child.on('error',reject);});
  const port=new URL(url).port,raw=(p,headers,method='GET',body)=>new Promise((ok,bad)=>{const r=http.request({host:'127.0.0.1',port,path:p,method,headers},res=>{res.resume();res.on('end',()=>ok(res.statusCode));});r.on('error',bad);if(body)r.write(body);r.end();});
  const list=JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'}),json={'Content-Type':'application/json'};
  assert.equal(await raw('/api/stats',{Host:'brain.example.test'}),200);
  assert.equal(await raw('/api/stats',{Host:'BRAIN.example.test'}),200);
  assert.equal(await raw('/mcp',{...json,Host:'brain.example.test',Origin:'https://brain.example.test'},'POST',list),200);
  assert.equal(await raw('/api/processing/run',{...json,Host:'brain.example.test',Origin:'https://brain.example.test'},'POST','{"max_units":0}')<500,true);
  assert.equal(await raw('/api/stats',{Host:'evil.example'}),403);
  assert.equal(await raw('/api/stats',{Host:'brain.example.test:8443'}),403);
  assert.equal(await raw('/mcp',{...json,Host:'brain.example.test',Origin:'https://evil.example'},'POST',list),403);
  assert.equal(await raw('/mcp',{...json,Host:'brain.example.test',Origin:'http://brain.example.test'},'POST',list),403);
  assert.equal(await raw('/api/processing/run',{...json,Origin:'https://evil.example'},'POST','{}'),403);
 }finally{child.kill();await new Promise(r=>child.once('exit',r));}
});
