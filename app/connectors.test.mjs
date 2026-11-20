import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {BrainStore} from './store.mjs';
import {ConnectorRegistry} from './connectors/registry.mjs';
import {importPayload} from './formats.mjs';
import {ownAssets} from './asset-store.mjs';
test('disabled source is never read; its captured data and BM25 remain available',async()=>{
 const s=new BrainStore(':memory:'),r=new ConnectorRegistry(s,{defaults:[{id:'obsidian',provider:'obsidian',name:'Obsidian',driver:'markdown-folder',enabled:false,config:{root:'Z:/this-folder-does-not-exist'}}]});
 s.ingest({provider:'obsidian',external_id:'saved',title:'Память',body:'Рефакторинг компонентов',messages:[{id:'note',role:'note',text:'Рефакторинг компонентов'}]});
 assert.equal((await r.collect('obsidian')).skipped,'disabled');assert.equal(s.search('рефакторингу').total,1);assert.equal(s.stats().sources,1);
 assert.equal(r.accepts('obsidian'),false);r.configure('obsidian',{enabled:true});assert.equal(r.accepts('obsidian'),true);s.close();
});
test('a broken connector does not stop another independently configured source',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'brain-modules-'));fs.writeFileSync(path.join(root,'note.md'),'# Проверка\n\nОбычная заметка');
 const s=new BrainStore(':memory:'),r=new ConnectorRegistry(s,{defaults:[{id:'broken',provider:'obsidian',name:'Unavailable',driver:'markdown-folder',enabled:true,config:{root:path.join(root,'missing')}},{id:'working',provider:'notes',name:'Independent notes',driver:'markdown-folder',enabled:true,config:{root}}]});
 const result=await r.collectAll();assert.ok(result.results.find(r=>r.id==='broken').error);assert.equal(result.results.find(r=>r.id==='working').changed,1);assert.equal(s.search('заметка').total,1);
 assert.equal((await r.collect('working')).unchanged,1);s.close();
});
test('disabled external connector rejects new arrivals and preserves existing records',()=>{
 const s=new BrainStore(':memory:'),r=new ConnectorRegistry(s),p={conversation_id:'fixture',title:'Проверка',messages:[]};
 r.configure('chatgpt',{enabled:false});assert.throws(()=>importPayload(s,p,{provider:'chatgpt',allowProvider:p=>r.accepts(p)}),/отключён/);assert.equal(s.stats().sources,0);
 r.configure('chatgpt',{enabled:true});assert.equal(importPayload(s,p,{provider:'chatgpt',allowProvider:p=>r.accepts(p)}).imported,1);s.close();
});
test('connector preferences survive a restart without deleting source data',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'brain-prefs-')),db=path.join(dir,'db.sqlite');let s=new BrainStore(db),r=new ConnectorRegistry(s);r.configure('obsidian',{enabled:false});s.close();
 s=new BrainStore(db);r=new ConnectorRegistry(s);assert.equal(r.get('obsidian').enabled,false);s.close();
});
test('a saved attachment is copied into canonical storage; the original stays unchanged',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'brain-assets-')),original=path.join(dir,'original.bin'),bytes=Buffer.from('independent attachment');fs.writeFileSync(original,bytes);
 const s=new BrainStore(':memory:');s.db.prepare('INSERT INTO assets VALUES(?,?,?,?,?,?,?,?)').run('a',null,'original.bin',original,null,bytes.length,'saved-unread','{}');
 const report=await ownAssets(s,path.join(dir,'canonical'));
 const saved=s.db.prepare('SELECT path FROM assets WHERE id=?').get('a').path;assert.equal(report.copied,1);assert.ok(saved.includes('canonical'));assert.deepEqual(fs.readFileSync(saved),bytes);assert.deepEqual(fs.readFileSync(original),bytes);
 assert.equal((await ownAssets(s,path.join(dir,'canonical'))).already_owned,1);s.close();
});
test('native session connector is standalone and skips unchanged files using lossless signatures',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'brain-native-')),p=path.join(root,'fixture.jsonl');
 fs.writeFileSync(p,[{type:'session_meta',payload:{id:'fixture'}},{type:'response_item',timestamp:'2026-11-01T10:00:00Z',payload:{type:'message',id:'m1',role:'user',content:[{type:'input_text',text:'Независимая локальная сессия'}]}}].map(r=>JSON.stringify(r)).join('\n'));
 const s=new BrainStore(':memory:'),r=new ConnectorRegistry(s,{defaults:[{id:'codex',provider:'codex',name:'Codex',driver:'native-files',enabled:true,config:{roots:[root],format:'codex-jsonl',quiet_seconds:0}}]});
 assert.equal((await r.collect('codex')).changed,1);assert.equal((await r.collect('codex')).sources,0);
 const checkpoint=JSON.parse(s.db.prepare("SELECT payload FROM connector_state WHERE id='files:codex'").get().payload);assert.equal(typeof Object.values(checkpoint)[0][0],'string');s.close();
});
test('empty native service file is checkpointed separately; later real messages are still collected',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'brain-native-empty-')),file=path.join(root,'empty.jsonl'),header=JSON.stringify({type:'session_meta',payload:{id:'later-real-source'}});fs.writeFileSync(file,header+'\n');
 const s=new BrainStore(':memory:'),registry=new ConnectorRegistry(s,{defaults:[{id:'codex',provider:'codex',name:'Codex',driver:'native-files',enabled:true,config:{roots:[root],format:'codex-jsonl',quiet_seconds:0}}]});
 const first=await registry.collect('codex');assert.equal(first.skipped_nonconversations,1);assert.deepEqual(first.errors,[]);assert.equal(s.stats().sources,0);assert.equal((await registry.collect('codex')).skipped_nonconversations,0);
 fs.appendFileSync(file,JSON.stringify({type:'response_item',timestamp:'2026-11-17T10:00:00Z',payload:{type:'message',id:'m',role:'user',content:[{type:'input_text',text:'Новое исходное сообщение после пустой сессии.'}]}})+'\n');assert.equal((await registry.collect('codex')).changed,1);assert.equal(s.stats().sources,1);assert.ok(fs.readFileSync(file,'utf8').startsWith(header));s.close();
});
