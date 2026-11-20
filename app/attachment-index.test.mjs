import {test} from 'node:test';import assert from 'node:assert/strict';
import {BrainStore} from './store.mjs';import {AttachmentIndex} from './attachment-index.mjs';
test('attachment text is indexed for its parent record: search finds the chat, quotes the attachment, agents can page through it',async()=>{
 const s=new BrainStore(':memory:'),chat=s.ingest({provider:'chatgpt',external_id:'att',title:'Обсуждение договора',body:'Посмотри файл',messages:[{id:'m1',role:'user',text:'Посмотри файл'}]});
 s.db.prepare('INSERT INTO assets(id,source_id,name,path,mime,bytes,state,metadata) VALUES(?,?,?,?,?,?,?,?)').run('asset-1',chat.id,'ТЗ интернет-магазина.pdf',process.cwd()+'/package-free-placeholder',null,10,'saved-unread','{}');
 s.db.prepare('INSERT INTO assets(id,source_id,name,path,mime,bytes,state,metadata) VALUES(?,?,?,?,?,?,?,?)').run('asset-2',chat.id,'photo.png',process.cwd()+'/x.png',null,10,'saved-unread','{}');
 const seen=[];const idx=new AttachmentIndex(s,{runner:async items=>{seen.push(...items.map(i=>i.name));return items.map(i=>({id:i.id,kind:'pdf',text:'Интернет-магазин: каталог, корзина и оплата картой. '.repeat(200)}));}});
 idx.pending=function(){return s.db.prepare('SELECT a.id,a.source_id,a.path,a.name,a.bytes FROM assets a LEFT JOIN asset_text t ON t.asset_id=a.id WHERE t.asset_id IS NULL').all().filter(a=>!/\.png$/.test(a.name));};
 const r=await idx.run();assert.equal(r.checked,1);assert.deepEqual(seen,['ТЗ интернет-магазина.pdf']);
 const hit=s.search('корзина каталог').results[0];assert.equal(hit.id,chat.id);assert.equal(hit.match_type,'attachment');assert.match(hit.snippet,/^Вложение «ТЗ интернет-магазина\.pdf»/);assert.equal(hit.attachment.id,'asset-1');
 assert.equal(s.search('договора').results[0].match_type,'content');
 const page=idx.read('asset-1',{offset:0,limit:1000});assert.equal(page.body.length,1000);assert.equal(page.next_offset,1000);assert.equal(idx.list(chat.id).find(x=>x.id==='asset-1').chars>0,true);
 assert.equal((await idx.run()).checked,0);s.close();});
