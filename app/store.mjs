import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {words,indexTerms,searchTerm,normalizePhrase} from './lib/lexical.mjs';
import {rankingOptions,rankedScore,dateMillis} from './lib/ranking.mjs';
import {parseQuery} from './lib/query.mjs';
import {projectGroup,projectId} from './project-groups.mjs';

export const DEFAULT_DB=fileURLToPath(new URL('../store/brain.sqlite',import.meta.url));
const stable=x=>Array.isArray(x)?x.map(stable):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,stable(x[k])])):x;
export const json=x=>JSON.stringify(stable(x));
export const hash=x=>createHash('sha256').update(typeof x==='string'||Buffer.isBuffer(x)?x:json(x)).digest('hex');
const stamp=()=>new Date().toISOString();
export const sourceKey=(provider,externalId,account='personal')=>provider+':'+(account==='personal'?'':account+':')+externalId;

export class BrainStore{
 constructor(filename=process.env.BRAIN_DB||DEFAULT_DB){
  this.filename=filename;
  if(filename!==':memory:')fs.mkdirSync(path.dirname(filename),{recursive:true});
  this.db=new DatabaseSync(filename,{timeout:10000});
  this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA journal_size_limit=67108864; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=10000;
   CREATE TABLE IF NOT EXISTS brain_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
   INSERT OR IGNORE INTO brain_meta VALUES('schema','secondbrain-canonical-v1');
   CREATE TABLE IF NOT EXISTS sources(id TEXT PRIMARY KEY,provider TEXT NOT NULL,external_id TEXT NOT NULL,account TEXT NOT NULL,
    kind TEXT NOT NULL,title TEXT NOT NULL,revision TEXT NOT NULL,source_date TEXT,date_basis TEXT,first_seen TEXT NOT NULL,
    captured_at TEXT NOT NULL,source_path TEXT,metadata TEXT NOT NULL,coverage TEXT NOT NULL,length INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS versions(source_id TEXT NOT NULL,revision TEXT NOT NULL,title TEXT NOT NULL,body TEXT NOT NULL,
    messages TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(source_id,revision),FOREIGN KEY(source_id) REFERENCES sources(id));
   CREATE TABLE IF NOT EXISTS aliases(alias TEXT PRIMARY KEY,source_id TEXT NOT NULL,FOREIGN KEY(source_id) REFERENCES sources(id));
   CREATE TABLE IF NOT EXISTS raw_captures(hash TEXT PRIMARY KEY,payload BLOB NOT NULL,mime TEXT NOT NULL,received_at TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS pending_captures(source_id TEXT NOT NULL,raw_hash TEXT NOT NULL,payload TEXT NOT NULL,
    reason TEXT NOT NULL,received_at TEXT NOT NULL,PRIMARY KEY(source_id,raw_hash));
   CREATE TABLE IF NOT EXISTS pending_capture_resolutions(source_id TEXT NOT NULL,raw_hash TEXT NOT NULL,revision TEXT NOT NULL,resolved_at TEXT NOT NULL,PRIMARY KEY(source_id,raw_hash));
   CREATE TABLE IF NOT EXISTS capture_receipts(source_id TEXT NOT NULL,revision TEXT NOT NULL,raw_hash TEXT NOT NULL,
    transport TEXT NOT NULL,received_at TEXT NOT NULL,PRIMARY KEY(source_id,revision,raw_hash,transport));
   CREATE TABLE IF NOT EXISTS terms(term TEXT NOT NULL,source_id TEXT NOT NULL,tf REAL NOT NULL,body INTEGER NOT NULL,
    PRIMARY KEY(term,source_id),FOREIGN KEY(source_id) REFERENCES sources(id));
   CREATE INDEX IF NOT EXISTS term_source ON terms(source_id);
   CREATE TABLE IF NOT EXISTS cards(source_id TEXT NOT NULL,revision TEXT NOT NULL,card_key TEXT NOT NULL,payload TEXT NOT NULL,
    reviewed_at TEXT NOT NULL,original_hash TEXT NOT NULL,PRIMARY KEY(source_id,revision,card_key));
   CREATE TABLE IF NOT EXISTS card_evidence(source_id TEXT NOT NULL,revision TEXT NOT NULL,original_hash TEXT NOT NULL,
    source_path TEXT NOT NULL,text TEXT NOT NULL,PRIMARY KEY(source_id,revision,original_hash));
   CREATE TABLE IF NOT EXISTS mail_categories(source_id TEXT PRIMARY KEY,category TEXT NOT NULL,rule TEXT,classified_at TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS asset_text(asset_id TEXT PRIMARY KEY,source_id TEXT,kind TEXT,chars INTEGER NOT NULL,text TEXT NOT NULL,error TEXT,extracted_at TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS asset_terms(term TEXT NOT NULL,source_id TEXT NOT NULL,asset_id TEXT NOT NULL,tf INTEGER NOT NULL,PRIMARY KEY(term,asset_id));
   CREATE INDEX IF NOT EXISTS asset_terms_source ON asset_terms(source_id);
   CREATE TABLE IF NOT EXISTS card_terms(term TEXT NOT NULL,source_id TEXT NOT NULL,revision TEXT NOT NULL,tf REAL NOT NULL,
    PRIMARY KEY(term,source_id,revision));
   CREATE TABLE IF NOT EXISTS assessments(source_id TEXT NOT NULL,revision TEXT NOT NULL,score REAL NOT NULL,
    payload TEXT NOT NULL,PRIMARY KEY(source_id,revision));
   CREATE TABLE IF NOT EXISTS assets(id TEXT PRIMARY KEY,source_id TEXT,name TEXT NOT NULL,path TEXT,mime TEXT,bytes INTEGER,
    state TEXT NOT NULL DEFAULT 'registered',metadata TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS links(source_id TEXT NOT NULL,target TEXT NOT NULL,kind TEXT NOT NULL,
    PRIMARY KEY(source_id,target,kind));
   CREATE TABLE IF NOT EXISTS project_assignments(source_id TEXT PRIMARY KEY,project_id TEXT NOT NULL,name TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS connector_state(id TEXT PRIMARY KEY,status TEXT NOT NULL,updated_at TEXT NOT NULL,payload TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS jobs(id INTEGER PRIMARY KEY,kind TEXT NOT NULL,started_at TEXT NOT NULL,finished_at TEXT,status TEXT NOT NULL,payload TEXT NOT NULL);
   CREATE VIRTUAL TABLE IF NOT EXISTS source_fts USING fts5(source_id UNINDEXED,title,body,tokenize='unicode61');`);
  if(this.db.prepare("SELECT value FROM brain_meta WHERE key='schema'").get().value!=='secondbrain-canonical-v1')throw Error('Unknown canonical database schema');
 }
 transaction(fn){this.db.exec('BEGIN IMMEDIATE');try{const r=fn();this.db.exec('COMMIT');return r;}catch(e){this.db.exec('ROLLBACK');throw e;}}
 ingest(record,{raw,transport='import',persistRaw=true}={}){
  if(!record||!/^[a-z][a-z0-9_-]{0,40}$/.test(record.provider)||typeof record.external_id!=='string'||!record.external_id)throw Error('Unknown source identity');
  if(typeof record.title!=='string'||!Array.isArray(record.messages)||typeof record.body!=='string')throw Error('Source requires title, body and messages');
  const messages=record.messages.map(m=>{
   if(typeof m.id!=='string'||!m.id||!['user','assistant','system','tool','note','email'].includes(m.role)||typeof m.text!=='string')throw Error('Invalid message identity/role/text');
   return {id:m.id,role:m.role,text:m.text,...(m.time?{time:m.time}:{})};
  });
  if(new Set(messages.map(m=>m.id)).size!==messages.length)throw Error('Duplicate message identities');
  const id=sourceKey(record.provider,record.external_id,record.account),account=record.account||'personal',kind=record.kind||(record.provider==='obsidian'?'note':'chat');
  const revision=hash({title:record.title,body:record.body,messages});
  const rawBytes=raw===undefined?null:Buffer.isBuffer(raw)?raw:Buffer.from(typeof raw==='string'?raw:json(raw));
  const rawHash=rawBytes?hash(rawBytes):record.raw_hash||revision,now=stamp();
  let sourceDate=record.source_date,dateBasis=record.date_basis||'source-declared';
  if(!sourceDate){sourceDate=messages.map(m=>m.time).filter(d=>dateMillis(d)!==null).sort((a,b)=>dateMillis(b)-dateMillis(a))[0]||null;dateBasis='message';}
  if(sourceDate&&dateMillis(sourceDate)===null)sourceDate=null;
  const result=this.transaction(()=>{
   const previous=this.db.prepare('SELECT revision,source_date FROM sources WHERE id=?').get(id),changed=previous?.revision!==revision;
   if(previous&&sourceDate&&previous.source_date&&dateMillis(sourceDate)<dateMillis(previous.source_date)){
    this.db.prepare('INSERT OR IGNORE INTO versions VALUES(?,?,?,?,?,?)').run(id,revision,record.title,record.body,json(messages),now);
    if(rawBytes&&persistRaw)this.db.prepare('INSERT OR IGNORE INTO raw_captures VALUES(?,?,?,?)').run(rawHash,rawBytes,'application/json',now);
    this.db.prepare('INSERT OR IGNORE INTO capture_receipts VALUES(?,?,?,?,?)').run(id,revision,rawHash,transport,now);
    return {id,revision:previous.revision,changed:false,new_source:false,archived_older_version:true,messages:messages.length};
   }
   this.db.prepare(`INSERT INTO sources VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
    kind=excluded.kind,title=excluded.title,revision=excluded.revision,source_date=excluded.source_date,date_basis=excluded.date_basis,
    captured_at=excluded.captured_at,source_path=coalesce(excluded.source_path,sources.source_path),metadata=excluded.metadata,coverage=excluded.coverage,length=excluded.length`).run(
     id,record.provider,record.external_id,account,kind,record.title,revision,sourceDate,dateBasis,now,now,record.source_path||null,json(record.metadata||{}),json(record.coverage||{}),words(record.body).length);
   this.db.prepare('INSERT OR IGNORE INTO versions VALUES(?,?,?,?,?,?)').run(id,revision,record.title,record.body,json(messages),now);
   if(rawBytes&&persistRaw)this.db.prepare('INSERT OR IGNORE INTO raw_captures VALUES(?,?,?,?)').run(rawHash,rawBytes,'application/json',now);
   this.db.prepare('INSERT OR IGNORE INTO capture_receipts VALUES(?,?,?,?,?)').run(id,revision,rawHash,transport,now);
   for(const alias of [record.source_path,...(record.aliases||[])].filter(Boolean))this.db.prepare('INSERT INTO aliases VALUES(?,?) ON CONFLICT(alias) DO UPDATE SET source_id=excluded.source_id').run(alias.replaceAll('\\','/'),id);
   if(changed){
    this.db.prepare('DELETE FROM terms WHERE source_id=?').run(id);
    const terms=new Map();
    for(const [text,weight,isBody]of [[record.title,4,0],[path.basename(record.source_path||''),2,0],[record.body,1,1]])for(const token of words(text))for(const t of indexTerms(token)){const r=terms.get(t)||{tf:0,body:0};r.tf+=weight;r.body+=isBody;terms.set(t,r);}
    const put=this.db.prepare('INSERT INTO terms VALUES(?,?,?,?)');for(const [t,r]of terms)put.run(t,id,r.tf,r.body);
    this.db.prepare('DELETE FROM source_fts WHERE source_id=?').run(id);this.db.prepare('INSERT INTO source_fts VALUES(?,?,?)').run(id,record.title,record.body);
    this.db.prepare('DELETE FROM links WHERE source_id=? AND kind=?').run(id,'wikilink');
    const link=this.db.prepare('INSERT OR IGNORE INTO links VALUES(?,?,?)');
    for(const m of record.body.matchAll(/\[\[([^\]|#]+)(?:[^\]]*)\]\]/g))link.run(id,m[1].trim(),'wikilink');
   }
   return {id,revision,changed,new_source:!previous,messages:messages.length};
  });
  return result;
 }
 attachCards(id,revision,items,originalHash){
  if(this.db.prepare('SELECT revision FROM sources WHERE id=?').get(id)?.revision!==revision)throw Error('Cannot attach stale cards');
  this.transaction(()=>{
   const put=this.db.prepare('INSERT INTO cards VALUES(?,?,?,?,?,?) ON CONFLICT(source_id,revision,card_key) DO UPDATE SET payload=excluded.payload,reviewed_at=excluded.reviewed_at');
   for(const {key,payload,reviewed_at}of items){if(typeof payload.reviewer!=='string'||!payload.reviewer.trim()||payload.sha256!==originalHash)throw Error('Only exact-version cards with a named reviewer model can be imported');put.run(id,revision,key,json(payload),reviewed_at,originalHash);}
   this.db.prepare('DELETE FROM card_terms WHERE source_id=? AND revision=?').run(id,revision);
   const terms=new Map();
   for(const r of this.db.prepare('SELECT payload FROM cards WHERE source_id=? AND revision=?').all(id,revision)){
    const c=JSON.parse(r.payload);for(const text of [c.title,...(c.questions||[]),...(c.keywords||[]),...(c.items||[]).map(i=>i.text)].filter(Boolean))for(const w of words(text))for(const term of indexTerms(w))terms.set(term,Math.min(6,(terms.get(term)||0)+1));
   }
   const add=this.db.prepare('INSERT INTO card_terms VALUES(?,?,?,?)');for(const [t,tf]of terms)add.run(t,id,revision,tf);
  });
 }
 search(query,{provider='',limit=30,offset=0,ranking='balanced',since,folder='',allowed_ids=null,service='include'}={}){
  const serviceOf=this.db.prepare('SELECT category,rule FROM mail_categories WHERE source_id=?');
  const policy=rankingOptions({ranking,since:since||undefined}),now=Date.now();
  const variants=query.split(' || ').slice(0,3).map(parseQuery);
  const docs=this.db.prepare('SELECT * FROM sources').all().filter(d=>(!allowed_ids||allowed_ids.has(d.id))&&(!provider||d.provider===provider)&&(!folder||(d.source_path||'').startsWith(folder))&&(policy.sinceMs===null||(dateMillis(d.source_date)??-Infinity)>=policy.sinceMs));
  const active=new Map(docs.map(d=>[d.id,d])),average=docs.reduce((n,d)=>n+d.length,0)/(docs.length||1)||1,hits=new Map();
  const allTerms=[...new Set(variants.flatMap(p=>p.terms.flatMap(t=>[t,searchTerm(t)])))];
  const postings=new Map(allTerms.map(t=>[t,new Map(this.db.prepare('SELECT source_id,tf,body FROM terms WHERE term=?').all(t).filter(r=>active.has(r.source_id)).map(r=>[r.source_id,r]))]));
  const cardPostings=new Map(allTerms.map(t=>[t,this.db.prepare('SELECT source_id,revision,tf FROM card_terms WHERE term=?').all(t).filter(r=>active.get(r.source_id)?.revision===r.revision)]));
  // Attachment text (PDF, DOCX, md…) counts for its parent record at half weight; the snippet then quotes the attachment.
  const assetPostings=new Map(allTerms.map(t=>[t,this.db.prepare('SELECT source_id,asset_id,tf FROM asset_terms WHERE term=?').all(t).filter(r=>active.has(r.source_id))]));
  for(const parsed of variants){
   const keys=[...new Set(parsed.terms.map(searchTerm))];
   const effective=new Map(allTerms.map(t=>{
    const rows=new Map([...postings.get(t)].map(([id,r])=>[id,{...r}]));
    if(!parsed.phrases.length)for(const c of cardPostings.get(t)){const old=rows.get(c.source_id);rows.set(c.source_id,{tf:(old?.tf||0)+c.tf*2,body:old?.body||0});}
    if(!parsed.phrases.length)for(const a of assetPostings.get(t)){const old=rows.get(a.source_id);rows.set(a.source_id,{tf:(old?.tf||0)+a.tf*.5,body:old?.body||0,asset:old?.asset||a.asset_id,assetOnly:old?old.assetOnly:true});}
    return [t,rows];
   }));
   const smallest=keys.reduce((a,b)=>effective.get(a).size<=effective.get(b).size?a:b);
   for(const id of effective.get(smallest).keys()){
    if(!keys.every(k=>effective.get(k).has(id)))continue;
    const d=active.get(id),v=this.db.prepare('SELECT body FROM versions WHERE source_id=? AND revision=?').get(id,d.revision);
    if(parsed.phrases.length){const fields=[normalizePhrase(d.title),normalizePhrase(v.body)];if(!parsed.phrases.every(p=>fields.some(f=>(' '+f+' ').includes(' '+p+' '))))continue;}
    let score=0;
    for(const t of keys){const df=effective.get(t).size,tf=effective.get(t).get(id).tf;score+=Math.log(1+(docs.length-df+0.5)/(df+0.5))*tf*2.2/(tf+1.2*(0.25+0.75*d.length/average));}
    const titleTerms=new Set(words(d.title+' '+path.basename(d.source_path||''))),titleKeys=new Set([...titleTerms].map(searchTerm));
    score+=keys.filter(k=>titleKeys.has(k)).length*2;
    score+=parsed.terms.filter(t=>searchTerm(t)!==t&&postings.get(t).has(id)).length*0.5;
    score+=parsed.terms.filter(t=>searchTerm(t)!==t&&titleTerms.has(t)).length*0.5;
    if(normalizePhrase(d.title)===parsed.phrase)score+=5;
    const assessment=this.db.prepare('SELECT score FROM assessments WHERE source_id=? AND revision=?').get(id,d.revision);
    const svc=d.provider==='email'?serviceOf.get(id):null;if(svc&&(svc.category==='code'&&service!=='only'||service==='exclude'))continue;if(!svc&&service==='only')continue;
    const rank=rankedScore(score,{source_dates:d.source_date?[{value:d.source_date,basis:d.date_basis}]:[]},assessment,now,policy.ranking);
    const literal=parsed.terms.map(t=>v.body.toLowerCase().indexOf(t)).filter(n=>n>=0),at=literal.length?Math.min(...literal):0;
    const viaAsset=keys.find(k=>effective.get(k).get(id).assetOnly),cardOnly=keys.some(k=>!postings.get(k).has(id));
    let snippet=v.body.slice(Math.max(0,at-100),Math.max(0,at-100)+360),attachment=null;
    if(viaAsset||(!literal.length&&keys.some(k=>effective.get(k).get(id).asset))){const assetId=effective.get(viaAsset||keys.find(k=>effective.get(k).get(id).asset)).get(id).asset,a=this.db.prepare('SELECT t.text,s.name FROM asset_text t JOIN assets s ON s.id=t.asset_id WHERE t.asset_id=?').get(assetId);
     if(a){const low=a.text.toLowerCase(),pos=parsed.terms.map(x=>low.indexOf(x)).filter(n=>n>=0),q=pos.length?Math.min(...pos):0;attachment={id:assetId,name:a.name};snippet='Вложение «'+a.name+'»: '+a.text.slice(Math.max(0,q-80),Math.max(0,q-80)+300);}}
    if(svc)rank.score*=0.3;
    const hit={...this.brief(d),...(svc?{service:{category:svc.category,rule:svc.rule}}:{}),score:rank.score,rank_factors:{lexical:score,freshness:rank.freshness_factor,usefulness:rank.usefulness_factor},match_type:viaAsset?'attachment':!parsed.phrases.length&&cardOnly?'source-card':'content',snippet,...(attachment?{attachment}:{}),match_offset:at};
    if(!hits.has(id)||hits.get(id).score<hit.score)hits.set(id,hit);
   }
  }
  const results=[...hits.values()].sort((a,b)=>(ranking==='recent'?(dateMillis(b.source_date)??-Infinity)-(dateMillis(a.source_date)??-Infinity):0)||b.score-a.score||a.id.localeCompare(b.id));
  const start=Math.max(0,Number(offset)||0);return {query,results:results.slice(start,start+Math.max(1,Math.min(100,limit))),total:results.length,search_mode:'indexed-bm25-all-terms',morphology:'russian-snowball-v1',ranking,model_calls:0};
 }
 brief(d){return {id:d.id,provider:d.provider,account:d.account,kind:d.kind,title:d.title,revision:d.revision,source_date:d.source_date,captured_at:d.captured_at,source_path:d.source_path,
  cards:this.db.prepare('SELECT count(*) n FROM cards WHERE source_id=? AND revision=?').get(d.id,d.revision).n};}
 detail(id,{offset=0,limit=20000}={}){
  const d=this.db.prepare('SELECT * FROM sources WHERE id=?').get(id);if(!d)return null;
  const v=this.db.prepare('SELECT body,messages FROM versions WHERE source_id=? AND revision=?').get(id,d.revision),from=Math.max(0,Number(offset)||0),size=Math.min(30000,Math.max(1000,Number(limit)||20000));
  const cards=this.db.prepare('SELECT card_key,payload,reviewed_at FROM cards WHERE source_id=? AND revision=? ORDER BY CASE WHEN card_key=\'synthesis\' THEN 0 WHEN card_key=\'full\' THEN 1 ELSE 2 END,card_key').all(id,d.revision);
  const guide=cards.find(r=>r.card_key==='full'||(r.card_key==='synthesis'&&JSON.parse(r.payload).synthesis_complete))||cards[0];
  return {...this.brief(d),coverage:JSON.parse(d.coverage),metadata:JSON.parse(d.metadata),body:v.body.slice(from,from+size),offset:from,total_chars:v.body.length,next_offset:from+size<v.body.length?from+size:null,
   message_count:JSON.parse(v.messages).length,card:guide?{...JSON.parse(guide.payload),reviewed_at:guide.reviewed_at}:null,card_count:cards.length,
   evidence_sources:this.db.prepare('SELECT original_hash,source_path FROM card_evidence WHERE source_id=? AND revision=?').all(id,d.revision),
   assets:this.db.prepare('SELECT id,name,path,mime,bytes,state FROM assets WHERE source_id=?').all(id)};
 }
 list({provider='',limit=100,offset=0,since}={}){const policy=rankingOptions({since:since||undefined}),rows=this.db.prepare('SELECT * FROM sources WHERE (?=\'\' OR provider=?) ORDER BY source_date DESC,title').all(provider,provider).filter(d=>policy.sinceMs===null||(dateMillis(d.source_date)??-Infinity)>=policy.sinceMs),start=Math.max(0,Number(offset)||0);return rows.slice(start,start+Math.min(100,Math.max(1,Number(limit)||100))).map(d=>this.brief(d));}
 state(id,status,payload){this.db.prepare('INSERT INTO connector_state VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,updated_at=excluded.updated_at,payload=excluded.payload').run(id,status,stamp(),json(payload));}
 stats(){return {app:'secondbrain-local-v1',sources:this.db.prepare('SELECT count(*) n FROM sources').get().n,versions:this.db.prepare('SELECT count(*) n FROM versions').get().n,
  providers:this.db.prepare('SELECT provider,count(*) count FROM sources GROUP BY provider ORDER BY count DESC').all(),
  mail_accounts:this.db.prepare("SELECT account,count(*) count FROM sources WHERE provider='email' GROUP BY account ORDER BY count DESC").all(),
  reviewed_sources:this.db.prepare('SELECT count(DISTINCT c.source_id) n FROM cards c JOIN sources s ON s.id=c.source_id AND s.revision=c.revision').get().n,
  cards:this.db.prepare('SELECT count(*) n FROM cards c JOIN sources s ON s.id=c.source_id AND s.revision=c.revision').get().n,
  assets:this.db.prepare('SELECT count(*) n FROM assets').get().n,connectors:this.db.prepare("SELECT * FROM connector_state WHERE id NOT IN ('native-files','note-files') AND id NOT LIKE 'files:%' ORDER BY id").all().map(r=>({...r,payload:JSON.parse(r.payload)})),
  timeline:this.db.prepare('SELECT substr(source_date,1,7) month,count(*) count FROM sources WHERE source_date IS NOT NULL GROUP BY month ORDER BY month').all(),weekly:this.db.prepare("SELECT date(substr(source_date,1,10),'-'||((CAST(strftime('%w',substr(source_date,1,10)) AS INTEGER)+6)%7)||' days') week,provider,count(*) count FROM sources WHERE source_date IS NOT NULL AND substr(source_date,1,10)>=date('now','-111 days') GROUP BY week,provider ORDER BY week").all(),
  model_calls_this_app:0,search_mode:'BM25 + Russian Snowball',db:this.filename};}
 assignProject(id,name){if(!this.db.prepare('SELECT 1 FROM sources WHERE id=?').get(id))throw Error('Source not found');if(typeof name!=='string'||name.trim().length>80)throw Error('Project name must be 1–80 characters');if(!name.trim())this.db.prepare('DELETE FROM project_assignments WHERE source_id=?').run(id);else this.db.prepare('INSERT INTO project_assignments VALUES(?,?,?) ON CONFLICT(source_id) DO UPDATE SET project_id=excluded.project_id,name=excluded.name').run(id,projectId(name.trim()),name.trim());return {saved:true};}
 graph({provider='',limit=3000,mode='projects'}={}){
  const rows=this.db.prepare('SELECT * FROM sources WHERE (?=\'\' OR provider=?) ORDER BY source_date DESC LIMIT ?').all(provider,provider,Math.min(3000,Math.max(20,Number(limit)||900))),nodes=rows.map(d=>({id:d.id,label:d.title,provider:d.provider,type:'source',cards:this.brief(d).cards})),ids=new Set(nodes.map(n=>n.id)),edges=[],topics=new Map();
  const allAliases=this.db.prepare('SELECT * FROM aliases').all(),aliasMap=new Map();
  for(const a of allAliases){const p=a.alias.replace(/\.md$/i,'');aliasMap.set(p,a.source_id);const stem=path.posix.basename(p);if(!aliasMap.has(stem))aliasMap.set(stem,a.source_id);else if(aliasMap.get(stem)!==a.source_id)aliasMap.set(stem,null);}
  for(const d of rows){
   for(const l of this.db.prepare('SELECT target FROM links WHERE source_id=?').all(d.id)){const to=aliasMap.get(l.target)||aliasMap.get(path.posix.join(path.posix.dirname(d.source_path||''),l.target));if(to&&to!==d.id&&ids.has(to))edges.push({source:d.id,target:to,kind:'wikilink'});}
   const cs=this.db.prepare('SELECT card_key,payload FROM cards WHERE source_id=? AND revision=?').all(d.id,d.revision),chosen=cs.find(c=>c.card_key==='synthesis'&&JSON.parse(c.payload).synthesis_complete)||cs.find(c=>c.card_key==='full');
   if(chosen)for(const label of [...new Set((JSON.parse(chosen.payload).keywords||[]).map(t=>t.trim()).filter(Boolean))].slice(0,6)){const key=normalizePhrase(label);if(!topics.has(key))topics.set(key,{label,ids:new Set()});topics.get(key).ids.add(d.id);}
  }
  for(const [key,t]of topics)if(t.ids.size>1){const id='topic:'+key;nodes.push({id,label:t.label,provider:'topic',type:'topic',degree:t.ids.size});for(const source of t.ids)edges.push({source,target:id,kind:'card-keyword'});}
  const projects=new Map();
  if(mode==='projects'){
   const assignments=new Map(this.db.prepare('SELECT * FROM project_assignments').all().map(a=>[a.source_id,a]));
   for(const d of rows){const g=projectGroup(d,assignments.get(d.id));if(!projects.has(g.id))projects.set(g.id,{...g,count:0,reviewed:0});const group=projects.get(g.id),n=nodes.find(n=>n.id===d.id);group.count++;if(n.cards)group.reviewed++;n.project_id=g.id;edges.push({source:g.id,target:d.id,kind:'project-membership',basis:g.basis});}
   for(const p of projects.values()){nodes.push({...p,provider:'project'});edges.push({source:'root:secondbrain',target:p.id,kind:'project-root'});}
   nodes.push({id:'root:secondbrain',label:'SecondBrain',type:'root',provider:'root',count:rows.length});
  }
  return {nodes,edges,projects:[...projects.values()].sort((a,b)=>b.count-a.count),mode,total_sources:this.stats().sources,limited:rows.length<this.db.prepare('SELECT count(*) n FROM sources WHERE (?=\'\' OR provider=?)').get(provider,provider).n,semantics:'project/folder membership + wikilinks + shared exact-version reviewed keywords'};
 }
 close(){this.db.close();}
}
