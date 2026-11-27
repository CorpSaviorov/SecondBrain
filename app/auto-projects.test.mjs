import {test} from 'node:test';import assert from 'node:assert/strict';
import {BrainStore} from './store.mjs';import {RecordViews} from './record-view.mjs';
import {AutoProjects,cleanProject} from './auto-projects.mjs';import {projectGroup,junkProject,projectId} from './project-groups.mjs';
const chat=(id,title,metadata={})=>({provider:'chatgpt',external_id:id,title,body:'Текст: '+title,messages:[{id:'m1',role:'user',text:'Текст: '+title}],metadata});
const card=(s,r,summary,keywords=[])=>s.attachCards(r.id,r.revision,[{key:'full',reviewed_at:'2026-11-20',payload:{schema:'source-card-v1',reviewer:'gpt-6-luna',sha256:'h',title:s.db.prepare('SELECT title FROM sources WHERE id=?').get(r.id).title,summary,keywords,items:[]}}],'h');
function provider(answer){const calls=[];return {calls,config:()=>({model:'gpt-6-luna',automatic:true}),requestJSON:async(packet,opts)=>{calls.push({packet,opts});return {value:answer(packet),reviewer:'tooken:gpt-6-luna',request_id:'req-'+calls.length};}};}
// Answers like Luna would, by the words in each record's title.
const byTitle=packet=>({assignments:packet.records.map(r=>({id:r.id,project:/SecondBrain/.test(r.title)?'SecondBrain':/продаж/i.test(r.title)?'Продажи':/здоров/i.test(r.title)?'Здоровье':/сомнит/i.test(r.title)?'Финансы':/Игра/.test(r.title)?'Игры':'',confidence:/сомнит/i.test(r.title)?'low':/Игра/.test(r.title)?'medium':'high'}))});

test('own names: ids and paths are not projects, aliases merge one project spelled differently',()=>{
 for(const s of ['g-p-0123456789abcdef0123456789abcdef','C--Users-User-Desktop-practice-x','C  Users User AppData Local Claude Data claude x scratch 2026','referenced-chatgpt-conversation-this-is-an','Obsidian Vault'])assert.ok(junkProject(s),s);
 for(const s of ['Продажи','react-learning','FCG Cabinet'])assert.equal(junkProject(s),false);
 assert.equal(projectGroup({provider:'chatgpt',metadata:{project_name:'English'}}).label,'English');assert.equal(projectGroup({provider:'codex',metadata:{project_directory:'C:/w/fcg-cabinet'}}).label,'fcg-cabinet');
 const junk={provider:'claude-code',metadata:{project_directory:'C:/x/g-p-0123456789abcdef0123456789abcdef'}};
 assert.equal(projectGroup(junk).type,'collection');assert.deepEqual(projectGroup(junk,null,'SecondBrain'),{id:projectId('SecondBrain'),label:'SecondBrain',type:'project',basis:'auto'});
 assert.equal(projectGroup({provider:'chatgpt',metadata:{project_name:'Продажи'}},null,'SecondBrain').label,'Продажи');
 assert.equal(projectGroup({provider:'chatgpt',metadata:{project_name:'Продажи'}},{project_id:'p',name:'Ручной'},'SecondBrain').label,'Ручной');
 assert.equal(cleanProject('«Проект SecondBrain».'),'SecondBrain');assert.equal(cleanProject('Платформа'),'');assert.equal(cleanProject('без проекта'),'');assert.equal(cleanProject('g-p-0123456789abcdef0123456789abcdef'),'');
});

test('Luna places records without a project; a new name needs three records, existing names count at once, doubts are ignored',async()=>{
 const s=new BrainStore(':memory:'),v=new RecordViews(s);
 const sales=s.ingest(chat('own','Скрипт продаж',{project_name:'Продажи'}));card(s,sales,'Скрипт холодного звонка',['скрипт продаж']);
 const sb=['SecondBrain: поиск','SecondBrain: карточки','SecondBrain: дизайн'].map((t,i)=>{const r=s.ingest(chat('sb'+i,t));card(s,r,'Работа над '+t);return r;});
 const junk=s.ingest(chat('junk','SecondBrain: шлюз',{project_name:'g-p-0123456789abcdef0123456789abcdef'}));
 const more=s.ingest(chat('more','Как улучшить продажи'));card(s,more,'Разбор воронки продаж');
 const games=[1,2,3].map(i=>s.ingest(chat('game'+i,'Игра '+i)));
 const health=s.ingest(chat('health','Здоровье: сон'));const once=s.ingest(chat('once','Разовый вопрос про погоду'));const doubt=s.ingest(chat('doubt','Сомнительная запись'));
 s.db.exec("CREATE TABLE IF NOT EXISTS mail_categories(source_id TEXT PRIMARY KEY,category TEXT NOT NULL,rule TEXT,classified_at TEXT NOT NULL)");
 const promo=s.ingest(chat('promo','SecondBrain рассылка'));s.db.prepare("INSERT INTO mail_categories VALUES(?,'promo',NULL,'x')").run(promo.id);
 s.db.exec("CREATE TABLE IF NOT EXISTS processing_queue(source_id TEXT NOT NULL,revision TEXT NOT NULL,status TEXT NOT NULL,reason TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(source_id,revision))");
 const pending=s.ingest(chat('pending','SecondBrain: ещё пишется'));s.db.prepare("INSERT INTO processing_queue VALUES(?,?,'waiting',NULL,'x','x')").run(pending.id,pending.revision);
 const p=provider(byTitle),a=new AutoProjects(s,p,v);
 const ids=a.candidates().map(x=>x.d.id);assert.ok(!ids.includes(sales.id)&&!ids.includes(promo.id)&&!ids.includes(pending.id));assert.ok(ids.includes(junk.id)&&ids.includes(once.id));
 const r=await a.run();assert.equal(p.calls.length,1);assert.equal(r.looked,11);
 const sent=p.calls[0].packet;assert.equal(p.calls[0].opts.task.name,'secondbrain_projects');assert.ok(sent.projects.some(x=>x.name==='Продажи'&&/скрипт продаж/.test(x.hint)));
 assert.match(sent.records.find(x=>x.title==='Как улучшить продажи').text,/воронки/);assert.match(sent.records.find(x=>x.title==='Здоровье: сон').text,/Текст/);
 for(const x of [...sb,junk])assert.deepEqual([v.group(s.db.prepare('SELECT * FROM sources WHERE id=?').get(x.id)).label,v.group(s.db.prepare('SELECT * FROM sources WHERE id=?').get(x.id)).basis],['SecondBrain','auto']);
 const salesGroup=v.group(s.db.prepare('SELECT * FROM sources WHERE id=?').get(more.id));assert.equal(salesGroup.id,projectId('Продажи'));
 for(const x of [health,once,doubt,...games])assert.equal(v.group(s.db.prepare('SELECT * FROM sources WHERE id=?').get(x.id)).type,'collection');
 const list=v.projects();assert.equal(list.find(x=>x.label==='Продажи').count,2);assert.equal(list.find(x=>x.label==='Продажи').auto,1);assert.equal(list.find(x=>x.label==='SecondBrain').count,4);
 const st=a.status();assert.equal(st.placed,5);assert.equal(st.waiting,0);assert.deepEqual(st.projects[0],{name:'SecondBrain',count:4});
 await a.run();assert.equal(p.calls.length,1,'nothing left: no second request');
 card(s,health,'Режим сна и восстановление');assert.deepEqual(a.candidates().map(x=>x.d.id),[health.id],'placed from the title: looked at again once its card appears');
 s.close();});

test('a batch stays within the packet limit, and a blocked worker sends nothing',async()=>{
 const s=new BrainStore(':memory:'),v=new RecordViews(s);for(let i=0;i<30;i++){const r=s.ingest(chat('n'+i,'Запись '+i));card(s,r,'Очень длинная выжимка '.repeat(30)+i);}
 const p=provider(byTitle),a=new AutoProjects(s,p,v);const {packet,batch}=a.packet(a.candidates(),a.vocabulary());
 assert.ok(batch.length>0&&batch.length<=20);assert.ok(JSON.stringify(packet).length<=18000);
 const blocked=new AutoProjects(s,p,v,{gate:()=>'Месячный лимит исчерпан'});assert.deepEqual(await blocked.run(),{blocked:true,reason:'Месячный лимит исчерпан'});assert.equal(p.calls.length,0);
 const busy=new AutoProjects(s,p,v,{busy:()=>true});assert.ok((await busy.run()).skipped);assert.equal(p.calls.length,0);
 s.close();});
