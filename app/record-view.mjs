import path from 'node:path';
import {projectGroup} from './project-groups.mjs';
import {dateMillis} from './lib/ranking.mjs';
import {serviceCategory,CATEGORY_NAMES} from './lib/mail-filter.mjs';
import {normalizePhrase,words,searchTerm} from './lib/lexical.mjs';
const STOP=new Set('это как что для или при его она они оно был была было быть есть нет так уже еще ещё все всё весь вся эти этот эта тот там тут где когда если чтобы через после перед более менее очень можно нужно надо также только просто пользователь пользователя пользователю ассистент ассистента ассистенту сообщил предложил предлагает хочет хотел попросил просит запросил уточнить понять сделать the and for with that this from are was you your have has not but'.split(' ').map(searchTerm));
export const AUTO_MIN=3;
const number=(v,fallback)=>Number.isFinite(Number(v))?Number(v):fallback;
export class RecordViews{
 constructor(store){this.store=store;store.db.exec(`CREATE TABLE IF NOT EXISTS auto_projects(source_id TEXT PRIMARY KEY,revision TEXT NOT NULL,project TEXT NOT NULL,confidence TEXT NOT NULL,basis TEXT NOT NULL,known INTEGER NOT NULL DEFAULT 0,model TEXT,request_id TEXT,assigned_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS record_annotations(source_id TEXT PRIMARY KEY,note TEXT NOT NULL,pinned INTEGER NOT NULL,version INTEGER NOT NULL,base_revision TEXT NOT NULL,updated_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS record_annotation_history(source_id TEXT NOT NULL,version INTEGER NOT NULL,note TEXT NOT NULL,pinned INTEGER NOT NULL,base_revision TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(source_id,version));`);}
 source(id){return this.store.db.prepare('SELECT * FROM sources WHERE id=?').get(id);}
 group(d){return projectGroup(d,this.store.db.prepare('SELECT * FROM project_assignments WHERE source_id=?').get(d.id),this.autoMap().get(d.id)||null);}
 // 2026-11-27 automatic projects: record id → project chosen by Luna. A name counts as a project when it is one of the
 // projects that already exist (known) or when at least AUTO_MIN records got it; doubtful (low) answers are ignored.
 // Re-read at most once a second, and only when the table changed.
 autoMap(){const now=Date.now();if(this.autoMemo&&now-this.autoMemo.at<1000)return this.autoMemo.map;
  const sig=JSON.stringify(this.store.db.prepare('SELECT count(*) n,max(assigned_at) a FROM auto_projects').get());if(this.autoMemo?.sig===sig){this.autoMemo.at=now;return this.autoMemo.map;}
  // known = the name is one of the owner's own projects (ChatGPT project, folder, manual choice); a new name needs
  // AUTO_MIN records with at least one confident («high») answer, so a vague grab-bag of «maybe» answers stays out.
  const rows=this.store.db.prepare("SELECT source_id,project,known,confidence FROM auto_projects WHERE project<>'' AND confidence<>'low'").all(),count=new Map(),high=new Map(),known=new Set(),spelling=new Map();
  for(const r of rows){const k=r.project.toLowerCase();count.set(k,(count.get(k)||0)+1);if(r.confidence==='high')high.set(k,(high.get(k)||0)+1);if(r.known)known.add(k);if(!spelling.has(k))spelling.set(k,r.project);}
  const map=new Map();for(const r of rows){const k=r.project.toLowerCase();if(known.has(k)||count.get(k)>=AUTO_MIN&&high.get(k)>=1)map.set(r.source_id,spelling.get(k));}
  this.autoMemo={at:now,sig,map};return map;}
 invalidateAuto(){this.autoMemo=null;}
 guide(d){const cards=this.store.db.prepare('SELECT card_key,payload,reviewed_at FROM cards WHERE source_id=? AND revision=?').all(d.id,d.revision),selected=cards.find(c=>c.card_key==='synthesis'&&JSON.parse(c.payload).synthesis_complete)||cards.find(c=>c.card_key==='full')||cards[0];return selected?{...JSON.parse(selected.payload),reviewed_at:selected.reviewed_at,key:selected.card_key}:null;}
 annotation(id){return this.store.db.prepare('SELECT * FROM record_annotations WHERE source_id=?').get(id)||{source_id:id,note:'',pinned:0,version:0,base_revision:null,updated_at:null};}
 saveAnnotation(id,{note='',pinned=false,expected_version=0,base_revision}={}){
  if(typeof note!=='string'||note.length>20000||typeof pinned!=='boolean')throw Error('Проверьте заметку к записи');
  return this.store.transaction(()=>{
   const d=this.source(id);if(!d)throw Error('Запись не найдена');
   if(base_revision!==d.revision){const e=Error('Исходная запись обновилась. Откройте её заново перед сохранением.');e.statusCode=409;throw e;}
   const old=this.annotation(id);if(number(expected_version,-1)!==old.version){const e=Error('Заметка изменена в другом окне. Обновите карточку.');e.statusCode=409;throw e;}
   if(old.note===note&&Boolean(old.pinned)===pinned)return {...old,saved:true,changed:false};
   const version=old.version+1,updated=new Date().toISOString();
   this.store.db.prepare('INSERT INTO record_annotations VALUES(?,?,?,?,?,?) ON CONFLICT(source_id) DO UPDATE SET note=excluded.note,pinned=excluded.pinned,version=excluded.version,base_revision=excluded.base_revision,updated_at=excluded.updated_at').run(id,note,Number(pinned),version,d.revision,updated);
   this.store.db.prepare('INSERT INTO record_annotation_history VALUES(?,?,?,?,?,?)').run(id,version,note,Number(pinned),d.revision,updated);
   return {...this.annotation(id),saved:true,changed:true};
  });
 }
 brief(d){const svc=d.provider==='email'?serviceCategory(this.store.db,d.id):null,c=this.guide(d),a=this.annotation(d.id),generic=/^(codex|claude-code|claude|chatgpt) · [0-9a-f-]{20,}$/i.test(d.title||'')&&c?.title&&c.title!=='Без полезных пунктов';return {...this.store.brief(d),...(svc?{service:{category:svc.category,label:CATEGORY_NAMES[svc.category]||svc.category,rule:svc.rule}}:{}),...(generic?{title:c.title}:{}),project:this.group(d),summary:c?.summary||'',keywords:c?.keywords||[],atom_count:c?.items?.length||0,partial:c?.coverage==='source-part'||c?.schema==='source-card-part-v1',reviewed_at:c?.reviewed_at||null,pinned:Boolean(a.pinned)};}
 filtered(options={}){
  const since=options.since?dateMillis(options.since):null,until=options.until?dateMillis(options.until):null;
  if(options.since&&since===null||options.until&&until===null)throw Error('Некорректный период');
  const reviewedSet=['true',true].includes(options.reviewed)?new Set(this.store.db.prepare('SELECT DISTINCT c.source_id id FROM cards c JOIN sources s ON s.id=c.source_id AND s.revision=c.revision').all().map(r=>r.id)):null;
  return this.store.db.prepare('SELECT * FROM sources ORDER BY source_date DESC,title').all().filter(d=>
   (!options.provider||d.provider===options.provider)&&(!options.project||this.group(d).id===options.project)&&
   (since===null||(dateMillis(d.source_date)??-Infinity)>=since)&&(until===null||(dateMillis(d.source_date)??Infinity)<until+86400000)&&
   (!reviewedSet||reviewedSet.has(d.id))&&(!['true',true].includes(options.pinned)||Boolean(this.annotation(d.id).pinned))&&
   (()=>{const mode=options.service||'exclude';if(d.provider!=='email')return mode!=='only';const svc=serviceCategory(this.store.db,d.id);return mode==='only'?Boolean(svc):mode==='include'?true:!svc;})());
 }
 records(options={}){
  const svcMode=options.service==='only'?'only':options.q?'include':'exclude',docs=this.filtered({...options,service:svcMode}),allowed=new Map(docs.map(d=>[d.id,d])),offset=Math.max(0,number(options.offset,0)),limit=Math.max(1,Math.min(100,number(options.limit,30)));
  let rows;if(options.q){const result=this.store.search(options.q,{provider:options.provider||'',ranking:options.ranking||'balanced',limit,offset,since:options.since||undefined,allowed_ids:new Set(allowed.keys()),service:svcMode==='only'?'only':'include'});rows=result.results.map(r=>({...this.brief(allowed.get(r.id)),snippet:r.snippet,score:r.score,rank_factors:r.rank_factors,match_type:r.match_type,...(r.attachment?{attachment:r.attachment}:{})}));return {query:options.q,results:rows,total:result.total,next_offset:offset+limit<result.total?offset+limit:null,search_mode:result.search_mode,model_calls:0};}
  // 2026-11-21: only the shown page is expanded (brief() for all ~1 600 records took ~0.33 s on every list open).
  rows=docs.slice(offset,offset+limit).map(d=>this.brief(d));
  return {query:'',results:rows,total:docs.length,next_offset:offset+limit<docs.length?offset+limit:null,search_mode:null,model_calls:0};
 }
 projects(){return this.cached('projects',()=>this.buildProjects());}
 buildProjects(){const groups=new Map(),reviewed=new Set(this.store.db.prepare('SELECT DISTINCT c.source_id id FROM cards c JOIN sources s ON s.id=c.source_id AND s.revision=c.revision').all().map(r=>r.id));for(const d of this.filtered()){const p=this.group(d);if(!groups.has(p.id))groups.set(p.id,{...p,count:0,reviewed:0,auto:0});const g=groups.get(p.id);g.count++;if(reviewed.has(d.id))g.reviewed++;if(p.basis==='auto')g.auto++;}return [...groups.values()].sort((a,b)=>b.count-a.count);}
 // Data version for caches: changes when sources, cards, links or manual project assignments change.
 fingerprint(){const db=this.store.db;return JSON.stringify([db.prepare('SELECT count(*) n,max(captured_at) c,total(length) l FROM sources').get(),db.prepare('SELECT count(*) n,max(reviewed_at) r FROM cards').get(),db.prepare('SELECT count(*) n FROM links').get(),db.prepare("SELECT count(*) n,group_concat(source_id||'='||project_id) p FROM project_assignments").get(),db.prepare('SELECT count(*) n,max(assigned_at) a FROM auto_projects').get()]);}
 // Neighbours from the full logical graph (links + meaning), built once per data version. Opening a record used to run a
 // full BM25 search for "related" on every click (~0.7 s); now it is a map lookup.
 neighbours(){return this.cached('neighbours',()=>{
  const map=new Map(),add=(a,b,e)=>{if(!map.has(a))map.set(a,[]);map.get(a).push({id:b,weight:e.weight,kinds:e.kinds,label:e.labels.find(l=>!l.startsWith('Проект:'))||e.labels[0]||''});};
  for(const e of this.network({limit:3000}).edges){if(e.kinds.length===1&&e.kinds[0]==='project')continue;add(e.source,e.target,e);add(e.target,e.source,e);}
  for(const list of map.values())list.sort((a,b)=>(b.kinds.includes('link')-a.kinds.includes('link'))||b.weight-a.weight);
  return map;});}
 related(id,limit=6){
  const d=this.source(id);if(!d)return [];const ranked=new Map();
  for(const n of this.neighbours().get(id)||[]){if(ranked.size>=limit)break;const o=this.source(n.id);if(o)ranked.set(o.id,{...this.brief(o),basis:n.kinds.includes('link')?'Ссылка в заметке':n.label||'Близкая по смыслу запись',score:n.weight});}
  const project=this.group(d);if(project.type==='project'&&ranked.size<limit)for(const other of this.filtered({project:project.id})){if(ranked.size>=limit)break;if(other.id!==id&&!ranked.has(other.id))ranked.set(other.id,{...this.brief(other),basis:'Тот же проект',score:0});}
  return [...ranked.values()];
 }
 detail(id,options={}){const d=this.source(id),raw=d&&this.store.detail(id,options);if(!d)return null;const c=this.guide(d),atoms=c?.items||[];return {...raw,project:this.group(d),summary:c?.summary||'',questions:c?.questions||[],keywords:c?.keywords||[],atoms,annotation:this.annotation(id),related:this.related(id),storage:{type:'sqlite',card_saved:Boolean(c),source_saved:true,reviewed_at:c?.reviewed_at||null,revision:d.revision,partial:c?.coverage==='source-part'||c?.schema==='source-card-part-v1',card_schema:c?.schema||null},card:c};}
 // Obsidian-style graph (user, 2026-11-18): records are linked LOGICALLY, never by folder alone.
 //  1. explicit links between notes ([[wikilinks]]);
 //  2. meaning: TF-IDF over Russian-stemmed card keywords (x3), card/source titles (x2), atoms and questions (x1);
 //     every record keeps its 4 closest records above a similarity floor, labelled with the shared topics;
 //  3. project hubs: one hub node per real project (3+ records), linked to its records like an Obsidian MOC note.
 // 2026-11-21 speed: one cache per data version, shared by the graph, «Похожие записи» and the project list (the first
 // click on a record after every 15-minute sync used to rebuild the whole graph, ~1.7 s). Term vectors of a record are
 // reused while the record and its cards are unchanged; similarity uses an index accumulator. Same edges as before.
 cached(key,build){const fp=this.fingerprint();if(this.cacheFp!==fp){this.cache=new Map();this.cacheFp=fp;}if(!this.cache.has(key))this.cache.set(key,build());return this.cache.get(key);}
 network(options={}){const o={provider:options.provider||'',project:options.project||'',since:options.since||'',until:options.until||'',limit:Math.min(3000,Math.max(50,number(options.limit,2000)))};return this.cached('network:'+JSON.stringify(o),()=>this.buildNetwork(o));}
 // [[wikilinks]] between the given records (same alias resolution as BrainStore.graph, without the rest of that view).
 wikilinks(docs){const ids=new Set(docs.map(d=>d.id)),aliasMap=new Map(),edges=[];
  for(const a of this.store.db.prepare('SELECT * FROM aliases').all()){const p=a.alias.replace(/\.md$/i,'');aliasMap.set(p,a.source_id);const stem=path.posix.basename(p);if(!aliasMap.has(stem))aliasMap.set(stem,a.source_id);else if(aliasMap.get(stem)!==a.source_id)aliasMap.set(stem,null);}
  const byId=new Map(docs.map(d=>[d.id,d]));for(const l of this.store.db.prepare("SELECT source_id,target FROM links WHERE kind='wikilink'").all()){const d=byId.get(l.source_id);if(!d)continue;const to=aliasMap.get(l.target)||aliasMap.get(path.posix.join(path.posix.dirname(d.source_path||''),l.target));if(to&&to!==d.id&&ids.has(to))edges.push({source:d.id,target:to});}
  return edges;}
 buildNetwork(options){
  const docs=this.filtered(options).slice(0,options.limit),ids=new Set(docs.map(d=>d.id)),pairs=new Map();
  const edge=(a,b,kind,label,weight=1)=>{if(a===b)return;const [s,t]=[a,b].sort(),key=s+'\n'+t,old=pairs.get(key)||{source:s,target:t,weight:0,kinds:[],labels:[]};old.weight=Math.max(old.weight,weight);if(!old.kinds.includes(kind))old.kinds.push(kind);if(label&&!old.labels.includes(label)&&old.labels.length<3)old.labels.push(label);pairs.set(key,old);};
  for(const e of this.wikilinks(docs))edge(e.source,e.target,'link','Ссылка в заметке',1);
  // 2. meaning
  const rows=new Map();for(const r of this.store.db.prepare('SELECT c.source_id,c.card_key,c.reviewed_at,c.payload FROM cards c JOIN sources s ON s.id=c.source_id AND s.revision=c.revision').iterate()){if(!ids.has(r.source_id))continue;if(!rows.has(r.source_id))rows.set(r.source_id,[]);rows.get(r.source_id).push(r);}
  this.termCache??=new Map();
  const entry=d=>{const rs=rows.get(d.id)||[],sig=d.revision+'\n'+d.title+'\n'+rs.map(r=>r.card_key+'@'+r.reviewed_at+'#'+r.payload.length).join('|'),hit=this.termCache.get(d.id);if(hit?.sig===sig)return hit;
   const list=[];for(const r of rs){try{list.push(JSON.parse(r.payload));}catch{}}
   const tf=new Map(),disp=new Map(),add=(text,w)=>{for(const word of words(String(text||''))){if(word.length<3||/^\d+$/.test(word))continue;const t=searchTerm(word);if(STOP.has(t))continue;if(!disp.has(t))disp.set(t,word);tf.set(t,(tf.get(t)||0)+w);}};
   add(d.title,2);for(const c of list){add(c.title,2);for(const k of c.keywords||[]){add(k,3);const phrase='k:'+normalizePhrase(k);if(phrase.length>4){if(!disp.has(phrase))disp.set(phrase,String(k).slice(0,40));tf.set(phrase,(tf.get(phrase)||0)+3);}}for(const q of c.questions||[])add(q,1);for(const i of c.items||[])add(i.text,1);}
   const e={sig,tf,disp,cards:list.length,cardTitle:list.map(c=>c.title).find(x=>x&&x!=='Без полезных пунктов')};this.termCache.set(d.id,e);return e;};
  const entries=new Map(docs.map(d=>[d.id,entry(d)])),display=new Map(),vectors=new Map(),df=new Map();
  for(const d of docs){const e=entries.get(d.id);for(const [t,w]of e.disp)if(!display.has(t))display.set(t,w);if(e.tf.size){vectors.set(d.id,e.tf);for(const t of e.tf.keys())df.set(t,(df.get(t)||0)+1);}}
  const N=Math.max(1,vectors.size),maxDf=Math.max(25,Math.round(N*.06)),postings=new Map();
  for(const [id,tf]of vectors){let norm=0;const v=new Map();for(const [t,f]of tf){const n=df.get(t);if(n<2||n>maxDf)continue;const w=(1+Math.log(f))*Math.log(1+N/n);v.set(t,w);norm+=w*w;}norm=Math.sqrt(norm)||1;if(v.size<3){vectors.delete(id);continue;}for(const [t,w]of v)v.set(t,w/norm);vectors.set(id,v);}
  // Numeric arrays for the similarity pass (same order of additions as the Map version, so identical scores).
  const keys=[...vectors.keys()],acc=new Float64Array(keys.length),termIds=new Map(),docTerms=keys.map((id,i)=>{const v=vectors.get(id),ti=new Int32Array(v.size),tw=new Float64Array(v.size);let k=0;for(const [t,x]of v){let n=termIds.get(t);if(n===undefined){n=termIds.size;termIds.set(t,n);postings.set(n,[]);}postings.get(n).push(i,x);ti[k]=n;tw[k++]=x;}return [ti,tw];});
  const plist=[...postings.values()];
  const candidates=[];for(let i=0;i<keys.length;i++){const touched=[],[ti,tw]=docTerms[i];for(let m=0;m<ti.length;m++){const p=plist[ti[m]],x=tw[m];for(let k=0;k<p.length;k+=2){const j=p[k];if(j===i)continue;if(acc[j]===0)touched.push(j);acc[j]+=x*p[k+1];}}
   const top=touched.map(j=>[j,acc[j]]).sort((a,b)=>b[1]-a[1]).slice(0,4);for(const j of touched)acc[j]=0;
   for(const [j,sc]of top){if(sc<.16)break;candidates.push([keys[i],keys[j],sc]);}}
  // Strongest first; no record gets more than 8 meaning links, so generic records cannot become false hubs.
  const topicDegree=new Map(),seen=new Set();for(const [id,other,s]of candidates.sort((a,b)=>b[2]-a[2])){const key=[id,other].sort().join('|');if(seen.has(key))continue;if((topicDegree.get(id)||0)>=8||(topicDegree.get(other)||0)>=8)continue;seen.add(key);topicDegree.set(id,(topicDegree.get(id)||0)+1);topicDegree.set(other,(topicDegree.get(other)||0)+1);
   const v=vectors.get(id),o=vectors.get(other),shared=[...new Set([...v].filter(([t])=>o.has(t)).sort((a,b)=>b[1]*o.get(b[0])-a[1]*o.get(a[0])).map(([t])=>String(display.get(t)||'').toLowerCase()).filter(Boolean))].slice(0,2);edge(id,other,'topic',shared.length?'Общие темы: '+shared.join(', '):'Близкие по смыслу',Math.round(s*100)/100);}
  // 3. project hubs
  const hubs=new Map();for(const d of docs){const p=this.group(d);if(p.type!=='project')continue;if(!hubs.has(p.id))hubs.set(p.id,{p,members:[]});hubs.get(p.id).members.push(d.id);}
  const hubNodes=[];for(const {p,members}of hubs.values()){if(members.length<3)continue;const id='project:'+p.id;hubNodes.push({id,label:p.label,provider:'hub',type:'hub',project_id:p.id,project_name:p.label,count:members.length});for(const m of members)edge(id,m,'project','Проект: '+p.label,.5);}
  const links=[...pairs.values()],degrees=new Map();for(const e of links)for(const id of [e.source,e.target])degrees.set(id,(degrees.get(id)||0)+1);
  const nodes=[...hubNodes.map(h=>({...h,degree:degrees.get(h.id)||0})),...docs.map(d=>{const p=this.group(d);const e=entries.get(d.id),ct=e.cardTitle;return {id:d.id,label:/^(codex|claude-code|claude|chatgpt) · [0-9a-f-]{20,}$/i.test(d.title||'')&&ct?ct:d.title,provider:d.provider,type:'source',source_date:d.source_date,project_id:p.id,project_name:p.label,cards:e.cards,degree:degrees.get(d.id)||0};})];
  const records=nodes.filter(n=>n.type==='source');
  return {nodes,edges:links,mode:'network',total_sources:this.store.db.prepare('SELECT count(*) n FROM sources').get().n,shown_sources:records.length,hubs:hubNodes.length,linked_sources:records.filter(n=>n.degree).length,isolated_sources:records.filter(n=>!n.degree).length,edge_kinds:Object.fromEntries(['link','topic','project'].map(k=>[k,links.filter(e=>e.kinds.includes(k)).length])),projects:this.projects(),semantics:'Явные ссылки между заметками, близость по смыслу (ключевые слова, заголовки и факты карточек с учётом русских словоформ) и хабы проектов. По папке связи не строятся.'};
 }
}
