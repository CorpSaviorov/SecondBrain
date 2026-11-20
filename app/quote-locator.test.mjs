import {test} from 'node:test';import assert from 'node:assert/strict';import {freezeSource,validateReview,locateQuote} from './card-packets.mjs';
const snap=text=>freezeSource({id:'chatgpt:md',revision:'r1',kind:'chat',source_path:null},{body:'',messages:JSON.stringify([{id:'m1',role:'assistant',text}])});
const review=quote=>({disposition:'card',title:'T',questions:['Q?'],keywords:['k'],uncertainties:[],items:[{kind:'assistant_suggestion',text:'Объяснение new',evidence:[{unit_id:'u0',role:'assistant',quote}]}]});
test('quote without inline Markdown markers is located and stored verbatim from the source',()=>{
 const s=snap('Это вызов той самой функции `User`, только **особым** способом.\n\nДальше пример.');
 const r=validateReview(review('вызов той самой функции User, только особым способом.'),s,0);const e=r.card.items[0].evidence[0];
 assert.equal(e.quote,'вызов той самой функции `User`, только **особым** способом.');assert.equal(s.text.slice(e.start_char,e.end_char),e.quote);
 assert.equal(e.located,'markdown-insensitive');assert.equal(e.model_quote,'вызов той самой функции User, только особым способом.');});
test('escaped punctuation and whitespace runs are tolerated; exact quotes keep exact flagless evidence',()=>{
 const text='Отлично'+String.fromCharCode(92)+'! Все   три файла на месте.';assert.ok(locateQuote(text,'Отлично! Все три файла на месте.'));
 const s=snap('Точная цитата остаётся точной.');const e=validateReview(review('Точная цитата остаётся точной.'),s,0).card.items[0].evidence[0];assert.equal(e.located,undefined);assert.equal(e.model_quote,undefined);});
test('locator still rejects invented words, ambiguous matches and very short fragments',()=>{
 assert.equal(locateQuote('Перенос продолжается. Перенос продолжается.','Перенос продолжается.'),null);
 assert.equal(locateQuote('проверяй теперь проект demo-project','проверяй проект demo-project'),null);
 assert.equal(locateQuote('a `b` c','b c'),null);
 assert.throws(()=>validateReview(review('Такого текста в источнике нет вообще.'),snap('Совсем другой текст сообщения.'),0));});
const chat=msgs=>freezeSource({id:'chatgpt:re',revision:'r1',kind:'chat',source_path:null},{body:'',messages:JSON.stringify(msgs.map(([role,text],i)=>({id:'m'+i,role,text})))});
const item=(kind,role,unit_id,quote)=>({disposition:'card',title:'T',questions:['Q?'],keywords:['k'],uncertainties:[],items:[{kind,text:'Пункт',evidence:[{unit_id,role,quote}]}]});
test('a quote attributed to a neighbouring message of the same role is accepted only when exactly one such message holds it',()=>{
 const s=chat([['user','Сделай отчёт по продажам за октябрь.'],['assistant','Готово.'],['user','Добавь сравнение с сентябрём, пожалуйста.']]);
 const e=validateReview(item('user_request','user','u0','Добавь сравнение с сентябрём'),s,0).card.items[0].evidence[0];
 assert.equal(e.message_id,'m2');assert.equal(e.model_unit,'u0');assert.equal(s.text.slice(e.start_char,e.end_char),'Добавь сравнение с сентябрём');
 const twice=chat([['user','Проверь договор поставки.'],['assistant','Ок.'],['user','Проверь договор поставки.'],['assistant','Ок.'],['user','Что ещё?']]);
 assert.throws(()=>validateReview(item('user_request','user','u4','Проверь договор поставки.'),twice,0));
 assert.throws(()=>validateReview(item('user_request','user','u0','Готово и проверено ассистентом'),chat([['user','Привет всем.'],['assistant','Готово и проверено ассистентом']]),0));});
test('unicode escapes in stored tool text match the decoded quote; the stored span stays verbatim',()=>{
 const B=String.fromCharCode(92),esc=c=>B+'u'+c.charCodeAt(0).toString(16).padStart(4,'0'),enc=s=>[...s].map(esc).join('');
 const raw='{"path":"/Obsidian Vault '+enc('—')+' '+enc('путь')+'/read"}';const hit=locateQuote(raw,'Obsidian Vault — путь/read');
 assert.ok(hit);assert.equal(raw.slice(hit.start,hit.end),'Obsidian Vault '+enc('—')+' '+enc('путь')+'/read');});
test('line breaks written by the model as literal backslash sequences match real CRLF in the source',()=>{
 const B=String.fromCharCode(92),CR=String.fromCharCode(13),LF=String.fromCharCode(10),src='function a() {'+CR+LF+'  let x = 1'+CR+LF+'}';
 const hit=locateQuote(src,'function a() {'+B+'r'+B+'n  let x = 1');assert.ok(hit);assert.equal(src.slice(hit.start,hit.end),'function a() {'+CR+LF+'  let x = 1');
 assert.equal(locateQuote(src,'function b() {'+B+'n  let x = 1'),null);});
test('transcript marks between segments of one speaker are skipped; a change of speaker or invented words still fail',()=>{
 const NL=String.fromCharCode(13,10),src='-- [00:13:30, speaker_2] стоимость работ у нас составляет 500 000, куда уже входит'+NL+NL+'-- [00:13:34, speaker_2] подготовка документов.'+NL+NL+'-- [00:13:40, speaker_1] А сроки какие?';
 const hit=locateQuote(src,'стоимость работ у нас составляет 500 000, куда уже входит подготовка документов.');assert.ok(hit);assert.ok(src.slice(hit.start,hit.end).includes('[00:13:34, speaker_2]'));
 assert.equal(locateQuote(src,'куда уже входит подготовка документов. А сроки какие?'),null);
 assert.equal(locateQuote(src,'стоимость работ у нас составляет 700 000, куда уже входит подготовка документов.'),null);
 assert.ok(locateQuote('Клиент написал:'+NL+'> Подскажите, у вас есть свободное время на неделе?','Подскажите, у вас есть свободное время на неделе?'));});
test('timestamp-line transcripts (00:43:50 / s0:) and page breaks: same speaker joins, a new speaker stays a hard break',()=>{
 const w='Каталог товаров на сайте, он не\r\n00:43:42\r\ns0: подтверждает наличие товара на складе.\r\n```\r\n\r\n## Страница 19\r\n\r\n```text\r\n00:43:50\r\ns0: Наличие товара на складе подтверждает... только менеджер\r\n00:43:55\r\ns1: Понятно, спасибо.';
 const hit=locateQuote(w,'Каталог товаров на сайте, он не подтверждает наличие товара на складе.');assert.ok(hit);assert.ok(w.slice(hit.start,hit.end).includes('00:43:42'));
 assert.ok(locateQuote(w,'подтверждает наличие товара на складе. Наличие товара на складе подтверждает'));
 assert.equal(locateQuote(w,'только менеджер Понятно, спасибо.'),null);
 assert.ok(locateQuote(w,'Понятно, спасибо.'));});
test('long source: a part where Luna finds nothing verifiable becomes an empty part; a short source still goes to manual review',()=>{
 const long=freezeSource({id:'n:long',revision:'r1',kind:'note',source_path:'a.md'},{title:'Длинная заметка',body:'Обсуждение звонка. '.repeat(1500),messages:'[]'});
 assert.equal(long.full,false);
 const manual={disposition:'needs-manual-review',title:'Обсуждение звонка',summary:'Нет содержания звонка',items:[],questions:['что было на звонке?'],keywords:['звонок'],uncertainties:['В этом фрагменте нет содержания звонка.']};
 const r=validateReview(manual,long,1,{previousFailures:1});assert.ok(r.card);assert.equal(r.card.empty_review,true);assert.equal(r.card.items.length,0);assert.ok(!r.manual);
 const short=freezeSource({id:'n:short',revision:'r1',kind:'note',source_path:'b.md'},{title:'Короткая',body:'Короткий текст про звонок.',messages:'[]'});
 assert.equal(short.full,true);assert.equal(validateReview(manual,short,0).manual,true);});
test('named transcript speakers: time marks and kept "Имя:" labels are skipped only within one speaker',()=>{
 const w='00:18:20\r\nАлексей: Мы ставим новую систему отопления. И\r\n00:18:27\r\nАлексей: вот теплом она потом по трубам\r\n00:18:31\r\nМарина: а это уже другая речь\r\n';
 assert.ok(locateQuote(w,'Мы ставим новую систему отопления. И вот теплом она потом по трубам'));
 assert.ok(locateQuote(w,'новую систему отопления. И\nАлексей: вот теплом она'));
 assert.equal(locateQuote(w,'потом по трубам а это уже другая речь'),null);
});
