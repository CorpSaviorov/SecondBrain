import {randomUUID} from 'node:crypto';
import {serviceCategory,loadRules,CATEGORY_NAMES} from './lib/mail-filter.mjs';
import {json,hash} from './store.mjs';
import {freezeSource,reviewPacket,validateReview,synthesisPacket,validateSynthesis,inheritCards} from './card-packets.mjs';
const stamp=()=>new Date().toISOString();
// Scheduled hourly pass: up to 20 bounded units (user decision 2026-11-18); manual button stays at 2. Monthly cost cap still applies.
export const SCHEDULED_UNITS=60,MANUAL_UNITS=2,PARALLEL_LANES=8,PRIMARY_LANES=8,REQUEST_RETRIES=3;
// The original provider admitted about 8 long requests at once per API key (measured 2026-11-18: scope=api_key_queue, queue-limit 2) for ALL
// models together, so 8 lanes is the ceiling. All lanes prefer the primary model (Luna); extra models are a fallback used
// only while the primary is paused by a model-scoped 429. A key-queue 429 (queue_full) makes just that lane wait a few seconds.
// Scheduled passes run up to PARALLEL_LANES different sources at once (user decision 2026-11-18). A source is marked
// 'processing' synchronously before any await, so two lanes never take the same source and parts stay sequential.
export class CardWorker{
 constructor(store,provider,{now=Date.now,intervalMs=1800000,queueBackoffMs=4000}={}){this.queueBackoffMs=queueBackoffMs;
  this.store=store;this.provider=provider;this.now=now;this.intervalMs=intervalMs;this.running=null;this.timer=null;this.owner=process.pid+':'+randomUUID();this.modelHolds={};this.stopping=false;
  store.db.exec(`CREATE TABLE IF NOT EXISTS processing_queue(source_id TEXT NOT NULL,revision TEXT NOT NULL,status TEXT NOT NULL,reason TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(source_id,revision));
   CREATE TABLE IF NOT EXISTS processing_snapshots(source_id TEXT NOT NULL,revision TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(source_id,revision));
   CREATE TABLE IF NOT EXISTS processing_runs(id TEXT PRIMARY KEY,trigger TEXT NOT NULL,status TEXT NOT NULL,units INTEGER NOT NULL,started_at TEXT NOT NULL,finished_at TEXT,error TEXT);
   CREATE TABLE IF NOT EXISTS processing_attempts(id TEXT PRIMARY KEY,run_id TEXT NOT NULL,source_id TEXT NOT NULL,revision TEXT NOT NULL,unit_key TEXT NOT NULL,status TEXT NOT NULL,request_id TEXT,error TEXT,started_at TEXT NOT NULL,finished_at TEXT);
   CREATE TABLE IF NOT EXISTS processing_drafts(attempt_id TEXT PRIMARY KEY,payload TEXT NOT NULL,created_at TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS processing_lock(id TEXT PRIMARY KEY,owner TEXT,expires INTEGER NOT NULL);
   INSERT OR IGNORE INTO processing_lock VALUES('single',NULL,0);`);
  if(!store.db.prepare("SELECT 1 FROM brain_meta WHERE key='card-worker-cutover'").get())store.transaction(()=>{
   const at=stamp();store.db.prepare("INSERT OR IGNORE INTO processing_queue SELECT id,revision,'historical','Существовало до переноса; архив не запускается заново',?,? FROM sources").run(at,at);
   store.db.prepare('INSERT INTO brain_meta VALUES(?,?)').run('card-worker-cutover',at);
  });
  store.db.exec(`CREATE TRIGGER IF NOT EXISTS processing_source_added AFTER INSERT ON sources BEGIN INSERT OR IGNORE INTO processing_queue VALUES(NEW.id,NEW.revision,'waiting',NULL,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')); END;
   CREATE TRIGGER IF NOT EXISTS processing_source_changed AFTER UPDATE OF revision ON sources WHEN NEW.revision<>OLD.revision BEGIN
   UPDATE processing_queue SET status='superseded',reason='Появилась новая версия',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE source_id=NEW.id AND revision<>NEW.revision AND status IN ('waiting','partial');
   INSERT OR IGNORE INTO processing_queue VALUES(NEW.id,NEW.revision,'waiting',NULL,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')); END;`);
  this.recover();
 }
 // A lock whose owner process no longer exists (restart, reboot, crash) is released at once instead of after the 15-minute lease.
 lockDead(l){const pid=Number(String(l.owner||'').split(':')[0]);if(!pid||pid===process.pid)return false;try{process.kill(pid,0);return false;}catch(e){return e.code==='ESRCH';}}
 recover(){const l=this.store.db.prepare("SELECT * FROM processing_lock WHERE id='single'").get();if(l.expires>this.now()&&!this.lockDead(l))return;
  this.store.transaction(()=>{
   this.store.db.prepare("UPDATE processing_lock SET owner=NULL,expires=0 WHERE id='single' AND owner IS ?").run(l.owner);
   // Interrupted units go back to the queue (saved part cards are kept); after REQUEST_RETRIES interruptions of the same source revision it waits for manual review.
   for(const q of this.store.db.prepare("SELECT source_id,revision FROM processing_queue WHERE status='processing'").all()){const n=this.store.db.prepare("SELECT count(*) n FROM processing_attempts WHERE source_id=? AND revision=? AND status='interrupted'").get(q.source_id,q.revision).n;
    this.store.db.prepare("UPDATE processing_queue SET status=?,reason=?,updated_at=? WHERE source_id=? AND revision=?").run(n<REQUEST_RETRIES?'waiting':'needs-review',n<REQUEST_RETRIES?'Запуск прерван перезапуском; повтор '+(n+1)+'/'+REQUEST_RETRIES:'Запуск прерван '+REQUEST_RETRIES+' раза. Повтор возможен вручную',stamp(),q.source_id,q.revision);}
   this.store.db.prepare("UPDATE processing_attempts SET status='interrupted',error='Процесс прерван',finished_at=? WHERE status='processing'").run(stamp());
   this.store.db.prepare("UPDATE processing_runs SET status='interrupted',finished_at=?,error='Процесс прерван' WHERE status='running'").run(stamp());
  });
 }
 enqueue(id,{reason='Перенесено из старой очереди'}={}){this.kick();
  const d=this.store.db.prepare('SELECT * FROM sources WHERE id=?').get(id);if(!d)throw Error('Источник не найден');
  if(this.complete(d))return {queued:false,reason:'already-reviewed'};
  this.store.db.prepare("INSERT INTO processing_queue VALUES(?,?,'waiting',?,?,?) ON CONFLICT(source_id,revision) DO UPDATE SET status=CASE WHEN status IN ('historical','excluded') THEN 'waiting' ELSE status END,reason=excluded.reason").run(id,d.revision,reason,stamp(),stamp());return {queued:true};
 }
 // Model-free recovery: re-check stored Luna drafts of 'complete-with-omissions' units with the current validator.
 // Only the current revision's card for the same unit is replaced, and only when strictly more items verify.
 // User-adjustable speed (2026-11-18): lanes 1..PARALLEL_LANES and an optional cap of requests per hour (0 = none).
 settings(){let s={};try{s=JSON.parse(this.store.db.prepare("SELECT value FROM brain_meta WHERE key='processing-settings'").get()?.value||'{}');}catch{}
  const lanes=Number.isInteger(s.lanes)&&s.lanes>=1&&s.lanes<=PARALLEL_LANES?s.lanes:PARALLEL_LANES,hourly_limit=Number.isInteger(s.hourly_limit)&&s.hourly_limit>=0&&s.hourly_limit<=5000?s.hourly_limit:0;return {lanes,hourly_limit};}
 lastHour(){return this.store.db.prepare('SELECT count(*) n,min(started_at) first FROM processing_attempts WHERE started_at>?').get(new Date(this.now()-3600000).toISOString());}
 capResumeAt(){const {hourly_limit}=this.settings();if(!hourly_limit)return null;const h=this.lastHour();return h.n>=hourly_limit?Date.parse(h.first)+3600000:null;}
 // Remaining model requests (unread windows + synthesis steps) and a time estimate. Measured 2026-11-18: real throughput is
 // ~70% of lanes x 3600 / seconds-per-request (pass boundaries, key-queue waits). Cached for a minute.
 estimate(){if(this.cachedEstimate&&this.now()-this.cachedEstimate.at<60000)return this.cachedEstimate.value;
  let units=0,sources=0;
  for(const r of this.store.db.prepare("SELECT s.*,v.messages,v.body,p.payload snap FROM processing_queue q JOIN sources s ON s.id=q.source_id AND s.revision=q.revision JOIN versions v ON v.source_id=s.id AND v.revision=s.revision LEFT JOIN processing_snapshots p ON p.source_id=s.id AND p.revision=s.revision WHERE q.status IN ('waiting','partial','processing')").iterate()){
   if(r.kind==='wiki'||/(^|\/)AGENTS\.md$/i.test(r.source_path||'')||!this.enabled(r)||this.serviceSkip(r))continue;
   let s;try{s=r.snap?JSON.parse(r.snap):freezeSource(r,{messages:r.messages,body:r.body});}catch{continue;}
   const parts=s.ranges.length,done=this.store.db.prepare("SELECT count(*) n FROM cards WHERE source_id=? AND revision=? AND card_key LIKE 'part:%'").get(r.id,r.revision).n;
   units+=parts>1?Math.max(0,parts-done)+Math.ceil(parts/4):(done?0:1);sources++;}
  const avg=this.store.db.prepare("SELECT avg((julianday(finished_at)-julianday(started_at))*86400) s FROM (SELECT started_at,finished_at FROM processing_attempts WHERE status LIKE 'complete%' AND finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 80)").get().s;
  const seconds=Math.max(3,Math.round(avg||25)),{lanes,hourly_limit}=this.settings(),speed=Math.round(lanes*3600/seconds*0.7),per_hour=hourly_limit?Math.min(speed,hourly_limit):speed;
  const value={sources,units,seconds_per_request:seconds,per_hour,eta_minutes:units?Math.ceil(units/Math.max(1,per_hour)*60):0};this.cachedEstimate={at:this.now(),value};return value;}
 // Queue entries that are not processed because their source is switched off, grouped by connector name.
 held(){const out=new Map();for(const d of this.store.db.prepare("SELECT s.* FROM processing_queue q JOIN sources s ON s.id=q.source_id AND s.revision=q.revision WHERE q.status IN ('waiting','partial')").iterate()){if(this.enabled(d))continue;const meta=JSON.parse(d.metadata||'{}'),c=(meta.connector_id&&this.store.db.prepare('SELECT * FROM source_connectors WHERE id=?').get(meta.connector_id))||this.store.db.prepare("SELECT * FROM source_connectors WHERE provider=? AND (json_extract(config,'$.account')=? OR id=?)").get(d.provider,d.account,d.account)||{id:d.provider},name=c.name||c.id;out.set(name,(out.get(name)||0)+1);}return [...out].map(([name,count])=>({name,count}));}
 // Return every needs-review entry to the queue (each gets the second-opinion model on its failed unit).
 kick(){this.store.db.prepare("INSERT INTO brain_meta VALUES('processing-kick',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(stamp());}
 retryAll(){this.kick();const n=this.store.db.prepare("UPDATE processing_queue SET status='waiting',reason='Повтор вторым мнением после ошибки проверки',updated_at=? WHERE status='needs-review'").run(stamp()).changes;this.cachedEstimate=null;return {requeued:Number(n),...this.status()};}
 pool(){const c=this.provider.config();return [c.model,...(c.extra_models||[])];}
 pickModel(lane){const pool=this.pool(),free=pool.filter(m=>!((this.modelHolds[m]||0)>this.now()));if(!free.length)return null;const pref=lane<PRIMARY_LANES||pool.length<2?pool[0]:pool[1+(lane-PRIMARY_LANES)%(pool.length-1)];return free.includes(pref)?pref:free[0];}
 // Model-free: sources held in needs-review because every quote of a stored answer failed are re-checked with the
 // current validator (neighbouring-message attribution, \uXXXX text). Only verified items are stored; the queue resumes.
 recoverCitationDrafts(){
  let recovered=0;
  const rows=this.store.db.prepare("SELECT a.id,a.source_id,a.revision,a.unit_key,d.payload draft,(SELECT u.model FROM model_usage u WHERE u.id=a.request_id) model FROM processing_queue q JOIN processing_attempts a ON a.source_id=q.source_id AND a.revision=q.revision AND a.status='invalid-output' AND a.error LIKE 'Цитата%' JOIN processing_drafts d ON d.attempt_id=a.id WHERE q.status='needs-review' AND a.unit_key NOT LIKE 'synthesis:%' AND NOT EXISTS(SELECT 1 FROM cards c WHERE c.source_id=a.source_id AND c.revision=a.revision AND c.card_key=a.unit_key) AND a.started_at=(SELECT max(b.started_at) FROM processing_attempts b JOIN processing_drafts bd ON bd.attempt_id=b.id WHERE b.source_id=a.source_id AND b.revision=a.revision AND b.unit_key=a.unit_key AND b.status='invalid-output' AND b.error LIKE 'Цитата%')").all();
  // 2026-11-20: per unit without a card, its latest CITATION-failed draft — a later empty answer («пустой обзор после
  // ошибки») no longer hides an earlier answer whose quotes now verify.
  for(const r of rows){try{
   const snap=this.store.db.prepare('SELECT payload FROM processing_snapshots WHERE source_id=? AND revision=?').get(r.source_id,r.revision);if(!snap)continue;
   const s=JSON.parse(snap.payload);if(hash(s.text)!==s.sha256)continue;const index=r.unit_key==='full'?0:Number(r.unit_key.split(':')[1]);
   const result=validateReview(JSON.parse(r.draft),s,index,{previousFailures:0});if(result.manual||!result.card.items.length)continue;
   this.store.attachCards(r.source_id,r.revision,[{key:r.unit_key,payload:{...result.card,...(r.model?{reviewer:r.model}:{}),recovered_from_draft:r.id},reviewed_at:stamp()}],s.sha256);
   this.finishAttempt(r.id,result.card.validation?.rejected_items?'complete-with-omissions':'complete');const d=this.store.db.prepare('SELECT * FROM sources WHERE id=?').get(r.source_id);
   this.mark(d,s.full?'complete':'partial','Перепроверено без модели: подтверждено '+result.card.items.length+' пунктов');recovered++;
  }catch{}}
  return recovered;
 }
 recoverOmissions(){
  let recovered=0,items=0;
  const rows=this.store.db.prepare("SELECT a.id,a.source_id,a.revision,a.unit_key,d.payload draft,c.payload card,c.reviewed_at FROM processing_attempts a JOIN processing_drafts d ON d.attempt_id=a.id JOIN sources s ON s.id=a.source_id AND s.revision=a.revision JOIN cards c ON c.source_id=a.source_id AND c.revision=a.revision AND c.card_key=a.unit_key WHERE a.status='complete-with-omissions' AND a.unit_key NOT LIKE 'synthesis:%'").all();
  for(const r of rows){try{
   const snap=this.store.db.prepare('SELECT payload FROM processing_snapshots WHERE source_id=? AND revision=?').get(r.source_id,r.revision);if(!snap)continue;
   const s=JSON.parse(snap.payload);if(s.revision!==r.revision||hash(s.text)!==s.sha256)continue;
   const old=JSON.parse(r.card),index=r.unit_key==='full'?0:Number(r.unit_key.split(':')[1]);
   const result=validateReview(JSON.parse(r.draft),s,index,{previousFailures:0});if(result.manual)continue;
   if(result.card.items.length<=old.items.length)continue;
   this.store.attachCards(r.source_id,r.revision,[{key:r.unit_key,payload:{...result.card,reviewer:old.reviewer||result.card.reviewer,recovered_from_draft:r.id},reviewed_at:r.reviewed_at}],s.sha256);
   if(!result.card.validation?.rejected_items)this.finishAttempt(r.id,'complete');
   recovered++;items+=result.card.items.length-old.items.length;
  }catch{}}
  return {recovered,items};
 }
 // Model-free: a unit held only because Luna's FIRST answer was an empty review in a non-canonical format is re-checked
 // from its stored draft. Units with an earlier citation failure stay held (an empty answer cannot escape a failure).
 // 2026-11-20: true when the previous answer for this unit was itself an empty review. Two consecutive empty answers
 // for ONE part of a multi-part source (e.g. a window of tool output) mean the part is really empty — it no longer
 // blocks the whole source. A whole-source empty answer after a failure still goes to the owner.
 lastAnswerEmpty(sourceId,revision,unitKey,exceptId=''){
  const prev=this.store.db.prepare("SELECT d.payload FROM processing_attempts a JOIN processing_drafts d ON d.attempt_id=a.id WHERE a.source_id=? AND a.revision=? AND a.unit_key=? AND a.id<>? ORDER BY a.started_at DESC LIMIT 1").get(sourceId,revision,unitKey,exceptId);
  try{const v=JSON.parse(prev?.payload||'null');return Boolean(v&&Array.isArray(v.items)&&!v.items.length&&v.disposition!=='needs-manual-review');}catch{return false;}
 }
 recoverEmptyDrafts(){
  let recovered=0;
  const rows=this.store.db.prepare("SELECT a.id,a.source_id,a.revision,a.unit_key,d.payload draft FROM processing_queue q JOIN sources s ON s.id=q.source_id AND s.revision=q.revision JOIN processing_attempts a ON a.source_id=q.source_id AND a.revision=q.revision AND a.status='invalid-output' JOIN processing_drafts d ON d.attempt_id=a.id WHERE q.status='needs-review' AND a.unit_key NOT LIKE 'synthesis:%' AND a.started_at=(SELECT max(b.started_at) FROM processing_attempts b WHERE b.source_id=a.source_id AND b.revision=a.revision)").all();
  for(const r of rows){try{
   const v=JSON.parse(r.draft);if(!Array.isArray(v.items)||v.items.length)continue;
   const earlier=this.store.db.prepare("SELECT count(*) n FROM processing_attempts WHERE source_id=? AND revision=? AND unit_key=? AND status='invalid-output' AND id<>?").get(r.source_id,r.revision,r.unit_key,r.id).n;
   const snap=this.store.db.prepare('SELECT payload FROM processing_snapshots WHERE source_id=? AND revision=?').get(r.source_id,r.revision);if(!snap)continue;
   const s=JSON.parse(snap.payload);if(hash(s.text)!==s.sha256)continue;if(earlier&&(s.full||!this.lastAnswerEmpty(r.source_id,r.revision,r.unit_key,r.id)))continue;const index=r.unit_key==='full'?0:Number(r.unit_key.split(':')[1]);
   const result=validateReview(v,s,index,{previousFailures:0});if(result.manual||!result.card.empty_review)continue;
   const author=this.store.db.prepare('SELECT u.model FROM processing_attempts a JOIN model_usage u ON u.id=a.request_id WHERE a.id=?').get(r.id)?.model;
   if(!s.full)this.store.attachCards(r.source_id,r.revision,[{key:r.unit_key,payload:{...result.card,...(author?{reviewer:author}:{})},reviewed_at:stamp()}],s.sha256);
   this.finishAttempt(r.id,'complete');const d=this.store.db.prepare('SELECT * FROM sources WHERE id=?').get(r.source_id);
   this.mark(d,s.full?'no-content':'partial',s.full?'Проверено: полезных пунктов нет':'Проверено указанное окно; полезных пунктов нет');recovered++;
  }catch{}}
  return recovered;
 }
 inheritFromPrevious(d,snapshot){
  // Deterministic, model-free reuse of validated windows from the latest earlier worker snapshot.
  const prev=this.store.db.prepare('SELECT p.revision,p.payload FROM processing_snapshots p JOIN versions v ON v.source_id=p.source_id AND v.revision=p.revision WHERE p.source_id=? AND p.revision<>? AND EXISTS(SELECT 1 FROM cards c WHERE c.source_id=p.source_id AND c.revision=p.revision) ORDER BY v.created_at DESC LIMIT 1').get(d.id,d.revision);
  if(!prev)return 0;
  const rows=this.store.db.prepare('SELECT card_key,payload,reviewed_at FROM cards WHERE source_id=? AND revision=?').all(d.id,prev.revision),at=new Map(rows.map(r=>[r.card_key,r.reviewed_at]));
  const items=inheritCards(snapshot,JSON.parse(prev.payload),new Map(rows.map(r=>[r.card_key,JSON.parse(r.payload)])),{reviewedAt:k=>at.get(k)||stamp()});
  if(items.length)this.store.attachCards(d.id,d.revision,items,snapshot.sha256);
  return items.length;
 }
 complete(d){return this.store.db.prepare("SELECT payload FROM cards WHERE source_id=? AND revision=? AND card_key IN ('full','synthesis')").all(d.id,d.revision).some(r=>{const c=JSON.parse(r.payload);return c.schema==='source-card-v1'||c.synthesis_complete===true;});}
 enabled(d){
  const tables=this.store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='source_connectors'").get();if(!tables)return true;
  const meta=JSON.parse(d.metadata),connector=meta.connector_id&&this.store.db.prepare('SELECT enabled FROM source_connectors WHERE id=?').get(meta.connector_id);
  if(connector)return Boolean(connector.enabled);const rows=this.store.db.prepare('SELECT enabled,config,id FROM source_connectors WHERE provider=?').all(d.provider);if(!rows.length)return true;
  const owners=rows.filter(r=>(JSON.parse(r.config).account||'personal')===d.account||r.id===d.account);return owners.length?owners.some(r=>r.enabled):rows.some(r=>r.enabled);
 }
 gate(){if(this.hold&&this.now()<this.hold.until)return this.hold.reason;const p=this.provider.status();if(!p.config.model)return 'Укажите модель в настройках';if(!p.key_saved)return 'Сохраните API-ключ модели';if(!p.tariff_confirmed)return 'Нужны подтверждённые тарифы входных и выходных токенов';if(p.remaining_usd<=0)return 'Месячный лимит исчерпан';return null;}
 status(){
  const counts=Object.fromEntries(this.store.db.prepare('SELECT status,count(*) count FROM processing_queue GROUP BY status').all().map(r=>[r.status,r.count]));
  const last=this.store.db.prepare('SELECT * FROM processing_runs ORDER BY started_at DESC LIMIT 1').get()||null,lock=this.store.db.prepare("SELECT owner,expires FROM processing_lock WHERE id='single'").get(),enabled=this.provider.config().automatic;
  const latest=this.store.db.prepare('SELECT q.source_id,q.revision,q.status,q.reason,q.updated_at,s.title,s.provider FROM processing_queue q JOIN sources s ON s.id=q.source_id WHERE q.status<>\'historical\' ORDER BY q.updated_at DESC LIMIT 25').all();
  const blocked=this.gate();return {enabled,active:enabled&&!blocked,running:Boolean(this.running)||lock.expires>this.now(),blocked_reason:blocked,models:this.pool(),held:this.held(),counts,last_run:last,latest,awaiting_pages:this.store.db.prepare('SELECT count(DISTINCT p.source_id) n FROM pending_captures p WHERE NOT EXISTS(SELECT 1 FROM pending_capture_resolutions r WHERE r.source_id=p.source_id AND r.raw_hash=p.raw_hash)').get().n,unit_limit:SCHEDULED_UNITS,parallel_lanes:this.settings().lanes,max_lanes:PARALLEL_LANES,settings:this.settings(),estimate:this.estimate(),hour_cap_until:(c=>c?new Date(c).toISOString():null)(this.capResumeAt()),manual_unit_limit:MANUAL_UNITS,interval_minutes:this.intervalMs/60000,cutover_at:this.store.db.prepare("SELECT value FROM brain_meta WHERE key='card-worker-cutover'").get().value,next_run_at:this.nextRunAt(),notice:'Работает пока запущен SecondBrain. После сна — один проход, без накопления пропущенных запусков.'};
 }
 configure({enabled,lanes,hourly_limit}={}){
  if(enabled===undefined&&lanes===undefined&&hourly_limit===undefined)throw Error('Нет изменений');
  if(enabled!==undefined&&typeof enabled!=='boolean')throw Error('Укажите включено или выключено');
  if(lanes!==undefined&&(!Number.isInteger(lanes)||lanes<1||lanes>PARALLEL_LANES))throw Error('Потоков: от 1 до '+PARALLEL_LANES);
  if(hourly_limit!==undefined&&(!Number.isInteger(hourly_limit)||hourly_limit<0||hourly_limit>5000))throw Error('Лимит в час: от 0 до 5000 (0 — без лимита)');
  if(lanes!==undefined||hourly_limit!==undefined){const s={...this.settings(),...(lanes!==undefined?{lanes}:{}),...(hourly_limit!==undefined?{hourly_limit}:{})};this.store.db.prepare("INSERT INTO brain_meta VALUES('processing-settings',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(s));this.cachedEstimate=null;}
  if(enabled!==undefined)this.provider.save({automatic:enabled});return this.status();}
 retry(id){this.kick();const d=this.store.db.prepare('SELECT revision FROM sources WHERE id=?').get(id);if(!d)throw Error('Источник не найден');this.store.db.prepare("UPDATE processing_queue SET status='waiting',reason='Ручной повтор после проверки ошибки',updated_at=? WHERE source_id=? AND revision=? AND status='needs-review'").run(stamp(),id,d.revision);return this.status();}
 revalidate(id){
  const d=this.store.db.prepare('SELECT * FROM sources WHERE id=?').get(id);if(!d)throw Error('Источник не найден');const a=this.store.db.prepare("SELECT * FROM processing_attempts WHERE source_id=? AND revision=? AND status='invalid-output' ORDER BY started_at DESC LIMIT 1").get(id,d.revision);if(!a||a.unit_key.startsWith('synthesis:'))return {saved:false,reason:'Нет подходящего проверяемого черновика'};
  const existing=this.store.db.prepare('SELECT payload FROM cards WHERE source_id=? AND revision=? AND card_key=?').get(id,d.revision,a.unit_key);if(existing)return {saved:false,reason:'Проверенная карточка уже сохранена'};
  const row=this.store.db.prepare('SELECT payload FROM processing_drafts WHERE attempt_id=?').get(a.id),snapshot=this.store.db.prepare('SELECT payload FROM processing_snapshots WHERE source_id=? AND revision=?').get(id,d.revision);if(!row||!snapshot)return {saved:false,reason:'Нет точного снимка'};
  const s=JSON.parse(snapshot.payload),v=JSON.parse(row.payload);if(s.revision!==d.revision||s.source_id!==id||hash(s.text)!==s.sha256)throw Error('Снимок источника не совпадает с версией');if(!v.items?.length)return {saved:false,reason:'Пустой результат после ошибки не принимается'};const index=a.unit_key==='full'?0:Number(a.unit_key.split(':')[1]);
  const result=validateReview(v,s,index,{previousFailures:1});if(result.manual)return {saved:false,reason:result.reason};
  const card=result.card;this.store.attachCards(id,d.revision,[{key:a.unit_key,payload:card,reviewed_at:a.finished_at||stamp()}],s.sha256);const omissions=card.validation?.rejected_items||0;this.finishAttempt(a.id,omissions?'complete-with-omissions':'complete');this.mark(d,s.full?'complete':'partial',omissions?'Сохранено подтверждённых пунктов: '+card.items.length+'; отклонено: '+omissions:null);return {saved:true,items:card.items.length,rejected:omissions,model_calls:0};
 }
 // Continuous drain (user decision 2026-11-18): after a run that saved at least one card, or an empty run, the next pass may start at once.
 // A run whose every unit failed backs off for the hourly interval, so an unavailable API is not hammered.
 nextRunAt(){const last=this.store.db.prepare("SELECT id,status,started_at,finished_at,units FROM processing_runs ORDER BY started_at DESC LIMIT 1").get();if(!last)return new Date(this.now()).toISOString();
  const ok=this.store.db.prepare("SELECT count(*) n FROM processing_attempts WHERE run_id=? AND status LIKE 'complete%'").get(last.id).n,cap=this.capResumeAt();
  if(cap)return new Date(Math.max(this.now(),cap)).toISOString();
  // An explicit requeue by the owner (retry, retry-all, enqueue) lifts the one-hour error back-off at once.
  const kick=this.store.db.prepare("SELECT value FROM brain_meta WHERE key='processing-kick'").get()?.value;if(kick&&kick>last.started_at)return new Date(this.now()).toISOString();
  // A pass that ended on a provider pause (429/402) resumes when the pause ends, not after the one-hour error back-off.
  if(this.hold&&this.hold.run===last.id)return new Date(Math.max(this.now(),this.hold.until)).toISOString();
  // A pass cut short by a restart/reboot is not an error pass: continue at once.
  if(last.finished_at&&(ok>0||last.units===0||last.status==='interrupted'))return new Date(this.now()).toISOString();
  return new Date(Math.max(this.now(),Date.parse(last.started_at)+this.intervalMs)).toISOString();}
 // Service mail (codes, receipts, ads, notifications) gets no Luna card unless the owner allows it in the mail filter.
 serviceSkip(d){if(d.provider!=='email')return null;const svc=serviceCategory(this.store.db,d.id);return svc&&!loadRules(this.store.db).process_service?svc:null;}
 hasWork(){return this.store.db.prepare("SELECT s.* FROM processing_queue q JOIN sources s ON s.id=q.source_id AND s.revision=q.revision WHERE q.status IN ('waiting','partial')").all().some(d=>this.enabled(d));}
 async run(trigger='manual',{maxUnits=trigger==='scheduled'?SCHEDULED_UNITS:MANUAL_UNITS,sourceId=null}={}){
  if(!Number.isInteger(maxUnits)||maxUnits<1||maxUnits>SCHEDULED_UNITS)throw Error('Допустимо до '+SCHEDULED_UNITS+' единиц за проход');
  if(this.running)return {busy:true};if(this.stopping)return {stopped:true};if(trigger==='scheduled'&&!this.hasWork())return {idle:true};if(!['manual','scheduled'].includes(trigger))throw Error('Неверный запуск');
  if(sourceId!==null&&(trigger!=='manual'||typeof sourceId!=='string'||sourceId.length>1000))throw Error('Неверный источник');
  const operation=this.execute(trigger,maxUnits,sourceId);this.running=operation;try{return await operation;}finally{this.running=null;}
 }
 async execute(trigger,maxUnits,sourceId){
  this.recover();const blocker=this.gate();if(blocker)return {blocked:true,reason:blocker};if(trigger==='scheduled'&&!this.provider.config().automatic)return {paused:true};
  const runId=randomUUID(),acquired=this.store.transaction(()=>{const l=this.store.db.prepare("SELECT * FROM processing_lock WHERE id='single'").get();if(l.expires>this.now())return false;
   if(trigger==='scheduled'&&Date.parse(this.nextRunAt())>this.now())return false;
   this.store.db.prepare("UPDATE processing_lock SET owner=?,expires=? WHERE id='single'").run(this.owner,this.now()+900000);
   this.store.db.prepare('INSERT INTO processing_runs VALUES(?,?,?,0,?,NULL,NULL)').run(runId,trigger,'running',stamp());return true;});
  if(!acquired)return {busy:true};let units=0,changed=0,errors=0;
  try{
   const lane=async laneIndex=>{while(units<maxUnits&&!this.stopping){this.store.db.prepare("UPDATE processing_lock SET expires=? WHERE id='single' AND owner=?").run(this.now()+900000,this.owner);if(this.gate()||trigger==='scheduled'&&!this.provider.config().automatic)break;
    if(trigger==='scheduled'&&this.capResumeAt())break;
    let model=this.pickModel(laneIndex);if(!model)break;
    const candidates=this.store.db.prepare("SELECT s.*,q.status queue_status FROM processing_queue q JOIN sources s ON s.id=q.source_id AND s.revision=q.revision WHERE q.status IN ('waiting','partial') ORDER BY (SELECT min(o.created_at) FROM processing_queue o WHERE o.source_id=q.source_id AND o.status<>'historical'),s.id").all();
    let d=candidates.find(d=>this.enabled(d)&&(!sourceId||d.id===sourceId));if(!d)break;
    if(this.complete(d)){this.mark(d,'complete','Карточка уже сохранена');continue;}
    // Only generated wiki notes (kind 'wiki') and AGENTS.md instruction files are derived; all other notes are primary sources.
    {const svc=this.serviceSkip(d);if(svc){this.mark(d,'excluded','Служебное письмо ('+(CATEGORY_NAMES[svc.category]||svc.category)+')');continue;}}
    if(d.kind==='wiki'||/(^|\/)AGENTS\.md$/i.test(d.source_path||'')){this.mark(d,'excluded','Производная Wiki или файл инструкций');continue;}
    let snapshot,unitKey,packet,index,parts,previous;try{
     const saved=this.store.db.prepare('SELECT payload FROM processing_snapshots WHERE source_id=? AND revision=?').get(d.id,d.revision);
     if(saved)snapshot=JSON.parse(saved.payload);else{
      const oldParts=this.store.db.prepare('SELECT count(*) n FROM cards WHERE source_id=? AND revision=?').get(d.id,d.revision).n;if(oldParts){this.mark(d,'needs-review','Есть прежние частичные карточки. Автоматическое повторное чтение отключено');continue;}
      snapshot=freezeSource(d,this.store.db.prepare('SELECT * FROM versions WHERE source_id=? AND revision=?').get(d.id,d.revision));
      this.store.transaction(()=>{this.store.db.prepare('INSERT INTO processing_snapshots VALUES(?,?,?)').run(d.id,d.revision,json(snapshot));this.store.db.prepare('INSERT OR IGNORE INTO card_evidence VALUES(?,?,?,?,?)').run(d.id,d.revision,snapshot.sha256,snapshot.path,snapshot.text);});
      this.inheritFromPrevious(d,snapshot);
     }
     if(!snapshot.units.some(u=>snapshot.text.slice(u.start,u.end).trim())){this.mark(d,'no-content','Нет сохранённых сообщений с текстом');continue;}
     const cards=this.store.db.prepare('SELECT card_key,payload FROM cards WHERE source_id=? AND revision=?').all(d.id,d.revision),byKey=new Map(cards.map(c=>[c.card_key,JSON.parse(c.payload)]));
     index=snapshot.ranges.findIndex((_,i)=>!byKey.has(snapshot.full?'full':'part:'+String(i).padStart(5,'0')));
     if(index>=0){unitKey=snapshot.full?'full':'part:'+String(index).padStart(5,'0');packet=reviewPacket(snapshot,index);}
     else{parts=snapshot.ranges.map((_,i)=>byKey.get('part:'+String(i).padStart(5,'0')));previous=byKey.get('synthesis');unitKey='synthesis:'+(previous?.incorporated_parts||0);packet=synthesisPacket(snapshot,parts,previous).packet;}
     if(JSON.stringify(packet).length>20000)throw Error('Пакет превышает допустимый размер');
    }catch(e){this.mark(d,'needs-review',e.message);errors++;continue;}
    const attempt=randomUUID(),previousFailures=this.store.db.prepare("SELECT count(*) n FROM processing_attempts WHERE source_id=? AND revision=? AND unit_key=? AND status='invalid-output'").get(d.id,d.revision,unitKey).n;
    if(previousFailures){const alt=this.pool().slice(1).find(m=>!((this.modelHolds[m]||0)>this.now()));if(alt)model=alt;}
    this.store.transaction(()=>{this.mark(d,'processing',unitKey);this.store.db.prepare('INSERT INTO processing_attempts VALUES(?,?,?,?,?,?,NULL,NULL,?,NULL)').run(attempt,runId,d.id,d.revision,unitKey,'processing',stamp());this.store.db.prepare('UPDATE processing_runs SET units=units+1 WHERE id=?').run(runId);});units++;
    let response;try{
     response=await this.provider.requestJSON(packet.units?{...packet,units:packet.units.map(u=>({id:u.id,role:u.role}))}:packet,{maxTokens:4096,model,onReserved:id=>this.store.db.prepare('UPDATE processing_attempts SET request_id=? WHERE id=?').run(id,attempt)});
     this.store.db.prepare('INSERT INTO processing_drafts VALUES(?,?,?)').run(attempt,json(response.value),stamp());
     const current=this.store.db.prepare('SELECT revision FROM sources WHERE id=?').get(d.id);if(current?.revision!==d.revision){this.finishAttempt(attempt,'superseded');this.mark(d,'superseded','Источник изменился во время запроса');continue;}
     if(!this.enabled(d)){this.finishAttempt(attempt,'cancelled');this.mark(d,'needs-review','Источник отключён во время запроса. Автоматического повторного списания нет');continue;}
     if(response.reviewer!==this.provider.config().provider+':'+model)throw Error('Ответ пришёл не от выбранной модели');
     const confirmedEmpty=previousFailures&&!snapshot.full&&!unitKey.startsWith('synthesis:')&&!response.value.items?.length&&this.lastAnswerEmpty(d.id,d.revision,unitKey,attempt);
     if(previousFailures&&!confirmedEmpty&&!response.value.items?.length&&!(response.value.disposition==='needs-manual-review'&&!snapshot.full))throw Error('Пустой обзор после ошибки проверки требует ручного решения');
     const result=unitKey.startsWith('synthesis:')?{card:validateSynthesis(response.value,snapshot,parts,previous)}:validateReview(response.value,snapshot,index,{previousFailures:confirmedEmpty?0:previousFailures});
     if(result.manual){this.finishAttempt(attempt,'needs-review',result.reason);this.mark(d,'needs-review',result.reason);continue;}
     result.card.reviewer=model;const card=result.card,key=unitKey.startsWith('synthesis:')?'synthesis':unitKey;
     if(!(snapshot.full&&card.empty_review))this.store.attachCards(d.id,d.revision,[{key,payload:card,reviewed_at:stamp()}],snapshot.sha256);
     this.finishAttempt(attempt,card.validation?.rejected_items?'complete-with-omissions':'complete');changed++;this.mark(d,card.schema==='source-card-v1'?(card.empty_review?'no-content':'complete'):card.synthesis_complete?'complete':'partial',card.empty_review?'Проверено указанное окно; полезных пунктов нет':card.validation?.rejected_items?'Подтверждено '+card.items.length+' пунктов; отклонено '+card.validation.rejected_items:null);
    }catch(e){errors++;this.finishAttempt(attempt,response?'invalid-output':'request-error',e.message);
     // No response at all (network, timeout, rate limit): requeue a bounded number of times; invalid model output is never auto-retried.
     const code=Number((/\((\d{3})[,)]/.exec(e.message)||[])[1]);
     // 429: the provider is throttling; pause all lanes for a minute without counting it as a failed attempt.
     if(!response&&code===429&&/queue_full/.test(e.message)){this.mark(d,'waiting','Ждёт: очередь провайдера заполнена, повтор через несколько секунд');await new Promise(r=>setTimeout(r,this.queueBackoffMs*(1+Math.random())));continue;}
     if(!response&&code===429){this.modelHolds[model]=this.now()+60000;const pool=this.pool();if(pool.every(m=>(this.modelHolds[m]||0)>this.now()))this.hold={run:runId,until:Math.min(...pool.map(m=>this.modelHolds[m])),reason:'Провайдер ограничил частоту запросов: пауза 1 минуту'};this.mark(d,'waiting','Ждёт: провайдер ограничил частоту запросов ('+model+')');continue;}
     if(!response&&[401,402,403].includes(code)){this.hold={run:runId,until:this.now()+1800000,reason:'Провайдер отклонил запрос ('+code+'): проверьте баланс и API-ключ. Повтор через 30 минут'};this.mark(d,'waiting','Ждёт: '+this.hold.reason);continue;}
     // First citation failure of a unit: one automatic retry with the second-opinion model instead of manual review.
     if(response&&!previousFailures&&this.pool().length>1&&!/Пустой обзор/.test(e.message)){this.mark(d,'waiting','Ошибка проверки цитат — повтор запасной моделью');continue;}
     const transient=!response&&!/лимит|ключ|тариф/i.test(e.message)?this.store.db.prepare("SELECT count(*) n FROM processing_attempts WHERE source_id=? AND revision=? AND unit_key=? AND status='request-error'").get(d.id,d.revision,unitKey).n:Infinity;
     if(transient<REQUEST_RETRIES)this.mark(d,'waiting','Временная ошибка запроса, повтор '+transient+'/'+REQUEST_RETRIES+': '+e.message);else this.mark(d,'needs-review',e.message);}
   }};
   await Promise.all(Array.from({length:trigger==='scheduled'?this.settings().lanes:1},(_,i)=>lane(i)));
   this.store.db.prepare('UPDATE processing_runs SET status=?,finished_at=? WHERE id=?').run(errors?'completed-with-errors':'complete',stamp(),runId);return {run_id:runId,units,changed_cards:changed,errors};
  }finally{this.cachedEstimate=null;this.store.db.prepare("UPDATE processing_lock SET owner=NULL,expires=0 WHERE id='single' AND owner=?").run(this.owner);}
 }
 mark(d,status,reason){this.store.db.prepare('UPDATE processing_queue SET status=?,reason=?,updated_at=? WHERE source_id=? AND revision=?').run(status,reason,stamp(),d.id,d.revision);}
 finishAttempt(id,status,error=null){this.store.db.prepare('UPDATE processing_attempts SET status=?,error=?,finished_at=? WHERE id=?').run(status,error,stamp(),id);}
 start(){if(this.timer)return;this.timer=setInterval(()=>this.run('scheduled').catch(()=>{}),30000);this.timer.unref();}
 async stop(){this.stopping=true;clearInterval(this.timer);if(this.running)await this.running;}
}
