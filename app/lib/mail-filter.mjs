// Service-mail filter (user request 2026-11-18). Real correspondence stays fully visible. Service mail — one-time
// codes, receipts, ads, notifications — stays in the base but gets no Luna card, is hidden from lists, overview and
// graph, and ranks lower in search. One-time codes are not stored at all unless the owner turns that on.
// Classification lives in mail_categories; the e-mail records themselves are never modified.
export const CATEGORY_NAMES={code:'код подтверждения',receipt:'чек или оплата',promo:'реклама или рассылка',notification:'уведомление',spam:'спам',custom:'по вашему правилу'};
// Robot sender addresses (2026-11-19): «noreply» anywhere, or a local part that only machines use. info@/support@/hello@
// are NOT here: small companies write from them by hand; those are caught only by bulk-mail headers.
const ROBOT_LOCAL=/no-?_?reply|do-?_?not-?_?reply|^(notifications?|notify|newsletters?|mailer(-daemon)?|robot\d*|alerts?|digest|verify|verification|emailverification|account-security[\w-]*|ofdreceipt|receipts?|recommendations|informer|secure_payment|cabinet|anketa|marketing|promo|bounces?|automated|accounts?-noreply)$/;
const JUNK_FOLDER=/(^|\/)(spam|junk|спам|bulk mail)$/i;
// Bulk-mail markers in the raw message header: mailing lists and robots set them, people's mail clients do not.
export function headerSignals(raw){const s=Buffer.from(raw).subarray(0,64*1024).toString('latin1'),end=s.search(/\r?\n\r?\n/),h=(end<0?s:s.slice(0,end)).replace(/\r?\n[ \t]+/g,' ');
 return {list:/^(list-unsubscribe|list-id):/im.test(h)||/^precedence:\s*(bulk|list|junk)/im.test(h),auto:/^auto-submitted:\s*(?!no\b)\S/im.test(h)||/^feedback-id:/im.test(h)||/^x-auto-response-suppress:\s*(all|oof|autoreply)/im.test(h)};}
export const DEFAULT_RULES={
 store_codes:false,      // false: new one-time-code e-mails are not saved at all
 process_service:false,  // false: service mail gets no Luna card
 senders:{
  // Fiscal data operators (Russian e-receipts) and calendar/account robots. Your own rules go to custom_senders.
  receipt:['ofd.ru','1-ofd.ru','pofd.ru','platformaofd.ru','taxcom.ru','ofd.yandex.ru','o-data.ru','check.ofd.ru'],
  promo:[],
  notification:['calendar.yandex.ru','id.yandex.ru','passport.yandex.ru','calendar.google.com']
 },
 // Bulk-mail sub-domains: «email.bank.ru», «mail.service.com», «news.shop.ru» → advertising; «notify.service.com» → notification.
 marketing_subdomains:['email','mail','news','newsletter','newsletters','promo','info','adv','marketing','club','mailer','mailing','rassylka','sender'],
 notify_subdomains:['notify','notification','notifications','noreply','no-reply','alerts'],
 subjects:{
  code:['ваш код','your code','код входа','код подтверждения','verification code','security code','одноразовый код','код для входа','уведомление о входе','login notification','new sign-in','новый вход в','sign-in attempt','вход в сервис','вход в аккаунт','оповещение системы безопасности','security alert'],
  receipt:['кассовый чек','чек на ','чек оплата','информация о платеже','receipt','payment received','оплата прошла','ваш заказ оплачен','подписка успешно'],
  promo:['скидк','скидок','выгод','распродаж','промокод','чёрная пятница','черная пятница','кэшбэк','кешбэк','sale','специальное предложение','подарок','одобрено'],
  notification:['вы создали пароль','напоминание о событии']
 },
 custom_senders:[],   // owner's own rules: domains or addresses, one per line in the mail card
 custom_subjects:[]   // owner's own rules: words in the subject
};
const clean=list=>[...new Set((Array.isArray(list)?list:[]).map(x=>String(x).trim().toLowerCase()).filter(x=>x&&x.length<=200))].slice(0,300);
// Built-in lists always come from this file (so improvements apply to everyone); only the owner's switches and own
// rules are stored.
// import_since (owner, 2026-11-19): mail older than this date is not imported at all ('' = whole history).
export function normalizeRules(r={}){const d=DEFAULT_RULES;return {store_codes:typeof r.store_codes==='boolean'?r.store_codes:d.store_codes,process_service:typeof r.process_service==='boolean'?r.process_service:d.process_service,import_since:/^\d{4}-\d{2}-\d{2}$/.test(String(r.import_since||''))&&Number.isFinite(Date.parse(r.import_since))?r.import_since:'',
 senders:Object.fromEntries(Object.entries(d.senders).map(([k,v])=>[k,clean(v)])),subjects:Object.fromEntries(Object.entries(d.subjects).map(([k,v])=>[k,clean(v)])),marketing_subdomains:clean(d.marketing_subdomains),notify_subdomains:clean(d.notify_subdomains),custom_senders:clean(r.custom_senders),custom_subjects:clean(r.custom_subjects)};}
const senderMatch=(address,list)=>{const a=String(address||'').toLowerCase(),domain=a.split('@')[1]||'';return list.some(x=>x.includes('@')?a===x:domain===x||domain.endsWith('.'+x));};
// Returns null for correspondence, otherwise {category, rule}.
// signals: {list, auto} from headerSignals(); folders: IMAP folders the message was seen in.
export function classifyMail({from,subject,inReplyTo,account,signals,folders},rules=DEFAULT_RULES){
 const s=String(subject||'').toLowerCase(),f=String(from||'').toLowerCase();
 if(/^\s*(re|fw|fwd|ответ|пересл\w*)\s*:/i.test(s)||inReplyTo||(account&&f===String(account).toLowerCase()))return null;
 const hit=(cat,list)=>{const w=list.find(x=>s.includes(x));return w?{category:cat,rule:'тема: '+w}:null;};
 const own=rules.custom_senders.find(x=>senderMatch(f,[x]));if(own)return {category:'custom',rule:'отправитель: '+own};
 const ownSubject=rules.custom_subjects.find(x=>s.includes(x));if(ownSubject)return {category:'custom',rule:'тема: '+ownSubject};
 const code=hit('code',rules.subjects.code);if(code)return code;
 if(folders?.length&&folders.every(x=>JUNK_FOLDER.test(x)))return {category:'spam',rule:'папка «Спам»'};
 for(const cat of ['receipt','promo','notification']){const d=rules.senders[cat].find(x=>senderMatch(f,[x]));if(d)return {category:cat,rule:'отправитель: '+d};}
 for(const cat of ['receipt','promo','notification']){const h=hit(cat,rules.subjects[cat]);if(h)return h;}
 if(signals?.list)return {category:'promo',rule:'рассылка: в письме есть ссылка «отписаться»'};
 if(signals?.auto)return {category:'notification',rule:'автоматическое письмо (служебный заголовок)'};
 const local=f.split('@')[0]||'';
 if(ROBOT_LOCAL.test(local))return {category:'notification',rule:'адрес робота: '+local+'@'};
 const parts=(f.split('@')[1]||'').split('.');
 if(parts.length>=3&&rules.notify_subdomains.includes(parts[0]))return {category:'notification',rule:'адрес уведомлений: '+f.split('@')[1]};
 if(parts.length>=3&&rules.marketing_subdomains.includes(parts[0]))return {category:'promo',rule:'рассылочный адрес: '+f.split('@')[1]};
 return null;
}
export function ensureTables(db){db.exec("CREATE TABLE IF NOT EXISTS mail_categories(source_id TEXT PRIMARY KEY,category TEXT NOT NULL,rule TEXT,classified_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS mail_signals(source_id TEXT PRIMARY KEY,list INTEGER NOT NULL,auto INTEGER NOT NULL)");}
// Header markers are read once from the stored raw message and cached; the record itself is not touched.
function signalsFor(db,id){const c=db.prepare('SELECT list,auto FROM mail_signals WHERE source_id=?').get(id);if(c)return {list:Boolean(c.list),auto:Boolean(c.auto)};
 let raw=null;try{raw=db.prepare("SELECT r.payload FROM capture_receipts c JOIN raw_captures r ON r.hash=c.raw_hash WHERE c.source_id=? AND r.mime='message/rfc822' LIMIT 1").get(id)?.payload;}catch{}
 if(!raw)return null;const v=headerSignals(raw);db.prepare('INSERT OR REPLACE INTO mail_signals VALUES(?,?,?)').run(id,Number(v.list),Number(v.auto));return v;}
function foldersFor(db,id){try{return db.prepare('SELECT DISTINCT folder FROM mail_locations WHERE source_id=?').all(id).map(r=>r.folder);}catch{return [];}}
export function loadRules(db){ensureTables(db);let v={};try{v=JSON.parse(db.prepare("SELECT value FROM brain_meta WHERE key='mail-filter'").get()?.value||'{}');}catch{}return normalizeRules(v);}
export function saveRules(db,r){const rules=normalizeRules(r);db.prepare("INSERT INTO brain_meta VALUES('mail-filter',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify({store_codes:rules.store_codes,process_service:rules.process_service,import_since:rules.import_since,custom_senders:rules.custom_senders,custom_subjects:rules.custom_subjects}));return rules;}
const facts=(db,d)=>{let m={};try{m=JSON.parse(d.metadata||'{}');}catch{}return {from:m.from?.[0]?.address||'',subject:d.title,inReplyTo:m.in_reply_to||null,account:d.account,signals:signalsFor(db,d.id),folders:foldersFor(db,d.id)};};
// Classify every e-mail record with the current rules and align the Luna queue (service mail is excluded unless allowed).
export function reclassify(db,rules=loadRules(db)){ensureTables(db);const now=new Date().toISOString(),counts={correspondence:0};
 const put=db.prepare('INSERT INTO mail_categories VALUES(?,?,?,?) ON CONFLICT(source_id) DO UPDATE SET category=excluded.category,rule=excluded.rule,classified_at=excluded.classified_at'),del=db.prepare('DELETE FROM mail_categories WHERE source_id=?');
 const hasQueue=Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE name='processing_queue'").get()),noop={run(){}};
 const exclude=!hasQueue?noop:db.prepare("UPDATE processing_queue SET status='excluded',reason=?,updated_at=? WHERE source_id=? AND status IN ('waiting','partial','needs-review')"),restore=!hasQueue?noop:db.prepare("UPDATE processing_queue SET status='waiting',reason='Снова обрабатывается: письмо больше не считается служебным',updated_at=? WHERE source_id=? AND status='excluded' AND reason LIKE 'Служебное письмо%'");
 db.exec('BEGIN');try{for(const d of db.prepare("SELECT id,title,account,metadata FROM sources WHERE provider='email'").all()){const c=classifyMail(facts(db,d),rules);
   if(c){put.run(d.id,c.category,c.rule,now);counts[c.category]=(counts[c.category]||0)+1;if(!rules.process_service)exclude.run('Служебное письмо ('+CATEGORY_NAMES[c.category]+')',now,d.id);else restore.run(now,d.id);}
   else{del.run(d.id);counts.correspondence++;restore.run(now,d.id);}}
  db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}return counts;}
export function classifyOne(db,d,rules=loadRules(db)){ensureTables(db);const c=classifyMail(facts(db,d),rules);if(c)db.prepare('INSERT INTO mail_categories VALUES(?,?,?,?) ON CONFLICT(source_id) DO UPDATE SET category=excluded.category,rule=excluded.rule,classified_at=excluded.classified_at').run(d.id,c.category,c.rule,new Date().toISOString());else db.prepare('DELETE FROM mail_categories WHERE source_id=?').run(d.id);return c;}
export function serviceCategory(db,id){try{return db.prepare('SELECT category,rule FROM mail_categories WHERE source_id=?').get(id)||null;}catch{return null;}}
