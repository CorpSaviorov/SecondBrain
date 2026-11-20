import {test} from 'node:test';
import assert from 'node:assert/strict';
import {BrainStore} from './store.mjs';
import {chatgptRecord,claudeRecord,importPayload} from './formats.mjs';
const record=(id,title,body,time='2026-04-01T10:00:00Z')=>({provider:'chatgpt',external_id:id,title,body,messages:[{id:'m1',role:'user',text:body,time}],source_date:time,coverage:{saved_text:true}});
test('repeat capture is idempotent and a changed source invalidates its card',()=>{
 const s=new BrainStore(':memory:'),a=record('a','Пример','Работа с типами'),first=s.ingest(a),repeat=s.ingest(a);
 assert.equal(first.changed,true);assert.equal(repeat.changed,false);assert.equal(s.stats().versions,1);
 s.attachCards(first.id,first.revision,[{key:'full',reviewed_at:'2026-11-15',payload:{schema:'source-card-v1',reviewer:'gpt-6-luna',sha256:'abc',title:'Пример',keywords:['супертипизация'],items:[],questions:[]}}],'abc');
 assert.equal(s.search('супертипизация').total,1);
 s.ingest({...a,body:'Совсем другой текст',messages:[{id:'m1',role:'user',text:'Совсем другой текст'}]});
 assert.equal(s.stats().versions,2);assert.equal(s.detail(first.id).card,null);assert.equal(s.search('супертипизация').total,0);s.close();
});
test('BM25, Russian morphology, paired terms and quoted original evidence',()=>{
 const s=new BrainStore(':memory:'),r=s.ingest(record('a','Рефакторинг приложения','Я приступил к рефакторингу компонентов.'));
 s.ingest(record('b','Другое','Компонент для примера'));
 assert.equal(s.search('рефакторинг').results[0].id,r.id);assert.equal(s.search('рефакторинг компонентов').total,1);
 assert.equal(s.search('"приступил к рефакторингу"').total,1);assert.equal(s.search('"приступил к рефакторинг"').total,0);
 assert.equal(s.search('несуществующий || рефакторинг').total,1);
 assert.equal(s.search('рефакторинг').model_calls,0);assert.equal(s.search('рефакторинг').search_mode,'indexed-bm25-all-terms');s.close();
});
test('card words cannot satisfy quoted queries',()=>{
 const s=new BrainStore(':memory:'),r=s.ingest(record('a','Источник','Оригинальный разговор'));
 s.attachCards(r.id,r.revision,[{key:'full',reviewed_at:'2026-11-15',payload:{reviewer:'gpt-6-luna',sha256:'abc',title:'Источник',keywords:['воображаемая фраза'],items:[],questions:[]}}],'abc');
 assert.equal(s.search('воображаемая фраза').total,1);assert.equal(s.search('"воображаемая фраза"').total,0);s.close();
});
test('capture time never replaces source date; since uses Moscow midnight',()=>{
 const s=new BrainStore(':memory:');s.ingest(record('a','Старый источник','общий запрос','2020-01-01T00:00:00Z'));
 s.ingest(record('b','Новый источник','общий запрос','2026-11-14T21:30:00Z'));
 assert.equal(s.search('общий запрос',{since:'2026-11-15'}).total,1);
 assert.equal(s.search('общий запрос',{ranking:'recent'}).results[0].id,'chatgpt:b');
 assert.equal(s.search('общий запрос',{ranking:'relevance'}).results[0].rank_factors.freshness,1);s.close();
});
test('invalid source cannot advance a capture and another account stays separate',()=>{
 const s=new BrainStore(':memory:'),a=record('a','Тест','Текст');s.ingest(a);s.ingest({...a,account:'second'});
 assert.equal(s.stats().sources,2);assert.throws(()=>s.ingest({...a,messages:[{id:'m',role:'bad',text:'x'}]}));assert.equal(s.stats().versions,2);s.close();
});
test('ChatGPT branch follows current leaf and partial captures are labelled',()=>{
 const r=chatgptRecord({id:'c',title:'Тест',current_node:'b',mapping:{a:{parent:null,message:{id:'m1',author:{role:'user'},content:{parts:['Вопрос']}}},b:{parent:'a',message:{id:'m2',author:{role:'assistant'},content:{parts:['Ответ']}}},c:{parent:'a',message:{id:'other',author:{role:'assistant'},content:{parts:['Другая ветка']}}}}});
 assert.deepEqual(r.messages.map(m=>m.id),['m1','m2']);
 assert.equal(chatgptRecord({conversation_id:'p',title:'Тест',messages:[],page_info:{has_previous_page:true}}).coverage.partial,true);
 assert.throws(()=>chatgptRecord({id:'x',current_node:'a',mapping:{a:{parent:'a'}}}));
});
test('Claude roles and literal message identities are retained',()=>{
 const r=claudeRecord({uuid:'c',name:'Тест',chat_messages:[{uuid:'m1',sender:'human',text:'Вопрос'},{uuid:'m2',sender:'assistant',content:[{type:'text',text:'Ответ'}]}]});
 assert.deepEqual(r.messages.map(m=>m.role),['user','assistant']);assert.equal(r.messages[1].text,'Ответ');
});
test('detail continuation is bounded and points to the same revision',()=>{
 const s=new BrainStore(':memory:'),r=s.ingest(record('a','Длинный','а'.repeat(50000))),a=s.detail(r.id),b=s.detail(r.id,{offset:a.next_offset});
 assert.equal(a.body.length,20000);assert.equal(b.offset,20000);assert.equal(a.revision,b.revision);assert.equal(a.body+b.body,'а'.repeat(40000));s.close();
});
test('late export is archived without rolling the current source backwards',()=>{
 const s=new BrainStore(':memory:'),r=s.ingest(record('a','Новый','Новая версия','2026-11-01T10:00:00Z'));
 const old=s.ingest(record('a','Старый','Старая версия','2026-01-01T10:00:00Z'));
 assert.equal(old.archived_older_version,true);assert.equal(s.detail(r.id).title,'Новый');assert.equal(s.stats().versions,2);s.close();
});
test('an incomplete direct capture is staged and never overwrites the full source',()=>{
 const s=new BrainStore(':memory:'),full={conversation_id:'a',title:'Полный',messages:[{id:'m1',author:{role:'user'},content:{parts:['Оригинал']}}],page_info:{has_previous_page:false}};
 importPayload(s,full,{provider:'chatgpt',transport:'direct-browser'});
 const result=importPayload(s,{...full,title:'Неполный',page_info:{has_previous_page:true}},{provider:'chatgpt',transport:'direct-browser'});
 assert.equal(result.pending,1);assert.equal(s.detail('chatgpt:a').title,'Полный');assert.equal(s.db.prepare('SELECT count(*) n FROM pending_captures').get().n,1);s.close();
});
