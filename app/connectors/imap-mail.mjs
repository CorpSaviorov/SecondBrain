import {MailAccounts,dependencies,safeMailError} from './mail-accounts.mjs';
import {storeMail} from './mail-record.mjs';
import {loadRules} from '../lib/mail-filter.mjs';
import {json} from '../store.mjs';
export async function syncMail(store,c,client,parse,{signal,isEnabled=()=>true,since=null,maxMessages=20,maxFolders=8,maxBytes=64*1024*1024,messageLimit=25*1024*1024}={}){
 store.db.exec('CREATE TABLE IF NOT EXISTS mail_checkpoints(connector_id TEXT NOT NULL,folder TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(connector_id,folder)); CREATE TABLE IF NOT EXISTS mail_deferred(connector_id TEXT NOT NULL,folder TEXT NOT NULL,uid_validity TEXT NOT NULL,uid INTEGER NOT NULL,reason TEXT NOT NULL,bytes INTEGER NOT NULL,PRIMARY KEY(connector_id,folder,uid_validity,uid));');
 const report={captured:0,changed:0,folders_checked:0,bytes:0,errors:[],deferred:0,catalog_scan_complete:false,read_only:true};
 const active=()=>{if(signal?.aborted||!isEnabled())throw Object.assign(Error('disabled'),{disabled:true});};
 const stateId='mail-round:'+c.id,old=store.db.prepare('SELECT payload FROM connector_state WHERE id=?').get(stateId),round=old?JSON.parse(old.payload):{offset:0};
 // Spam and Trash are not imported (owner, 2026-11-19: no junk in the base). Mail already saved from them stays.
 const skipFolder=f=>['\\Junk','\\Trash'].includes(f.specialUse)||/(^|\/)(spam|junk|trash|deleted( items| messages)?|спам|корзина|удал[её]нные)$/i.test(f.path);
 active();const folders=(await client.list()).filter(f=>typeof f.path==='string'&&!f.flags?.has('\\Noselect')&&!skipFolder(f)).sort((a,b)=>a.path.localeCompare(b.path));
 const selected=Array.from({length:Math.min(maxFolders,folders.length)},(_,i)=>folders[(round.offset+i)%folders.length]);
 for(const folder of selected){active();if(report.captured>=maxMessages||report.bytes>=maxBytes)break;let lock;try{
  lock=await client.getMailboxLock(folder.path,{readOnly:true});active();const box=client.mailbox,validity=String(box.uidValidity),top=Number(box.uidNext)-1;
  if(!Number.isSafeInteger(top)||top<0||!validity||validity==='undefined')throw Error('Invalid mailbox identity');
  const saved=store.db.prepare('SELECT payload FROM mail_checkpoints WHERE connector_id=? AND folder=?').get(c.id,folder.path);let checkpoint=saved?JSON.parse(saved.payload):null;
  if(!checkpoint||checkpoint.validity!==validity)checkpoint={validity,newHigh:top,backfill:top,turn:'backfill'};
  // Date limit: history below the first UID dated on/after `since` is never read (the checkpoint marks it done).
  let floor=1;if(since&&checkpoint.backfill>0&&typeof client.search==='function'){active();const found=await client.search({since},{uid:true});floor=Array.isArray(found)&&found.length?found.reduce((a,b)=>Math.min(a,Number(b)),Infinity):top+1;if(checkpoint.backfill<floor)checkpoint.backfill=0;}
  const pendingNew=top>checkpoint.newHigh,mode=pendingNew&&(checkpoint.turn==='new'||checkpoint.backfill<=0)?'new':'backfill';
  let lo=mode==='new'?checkpoint.newHigh+1:Math.max(floor,checkpoint.backfill-99),hi=mode==='new'?Math.min(top,lo+99):checkpoint.backfill;
  if(hi>=lo){active();const metas=await client.fetchAll(`${lo}:${hi}`,{uid:true,size:true,emailId:true},{uid:true});const rows=metas.filter(m=>m.uid>=lo&&m.uid<=hi).sort((a,b)=>mode==='new'?a.uid-b.uid:b.uid-a.uid);let last=null,done=true;
   for(const m of rows){active();if(report.captured>=maxMessages||report.bytes>=maxBytes){done=false;break;}
    if(m.size>messageLimit){store.db.prepare('INSERT OR REPLACE INTO mail_deferred VALUES(?,?,?,?,?,?)').run(c.id,folder.path,validity,m.uid,'message-over-25-MiB',m.size);last=m.uid;continue;}
    if(report.bytes+m.size>maxBytes){done=false;break;}
    const full=await client.fetchOne(String(m.uid),{uid:true,source:true,emailId:true},{uid:true});active();
    if(!full){last=m.uid;continue;}
    if(!Buffer.isBuffer(full.source)||full.source.length>messageLimit)throw Error('Invalid or oversized message body');
    report.bytes+=full.source.length;const parsed=await parse(full.source,{skipHtmlToText:false,skipTextToHtml:true});active();const result=storeMail(store,c,full.source,parsed,{folder:folder.path,uid:m.uid,uidValidity:validity,emailId:full.emailId||m.emailId});report.captured++;report.changed+=Number(result.changed);last=m.uid;
   }
   if(mode==='new')checkpoint.newHigh=done?hi:last??checkpoint.newHigh;else checkpoint.backfill=done?lo-1:last===null?checkpoint.backfill:last-1;
  }
  if(checkpoint.backfill<floor)checkpoint.backfill=0;checkpoint.topSeen=top;checkpoint.turn=mode==='new'?'backfill':'new';store.db.prepare('INSERT OR REPLACE INTO mail_checkpoints VALUES(?,?,?)').run(c.id,folder.path,json(checkpoint));report.folders_checked++;
 }catch(e){if(e.disabled)throw e;console.error('mail folder',c.id,folder.path,safeMailError(e));report.errors.push({message:'Не удалось дочитать одну папку. Её курсор сохранён; остальные источники продолжают работу.'});}finally{lock?.release();}
 round.offset=(folders.indexOf(folder)+1)%Math.max(1,folders.length);store.state(stateId,'checkpoint',round);
 }
 const all=store.db.prepare('SELECT folder,payload FROM mail_checkpoints WHERE connector_id=?').all(c.id),byFolder=new Map(all.map(p=>[p.folder,JSON.parse(p.payload)]));report.remaining_folders=folders.filter(f=>!byFolder.has(f.path)||byFolder.get(f.path).backfill>0||byFolder.get(f.path).newHigh<byFolder.get(f.path).topSeen).length;report.catalog_scan_complete=report.remaining_folders===0&&report.errors.length===0;report.deferred=store.db.prepare('SELECT count(*) n FROM mail_deferred WHERE connector_id=?').get(c.id).n;return report;
}
export async function collect(store,c,options={}){const accounts=new MailAccounts(store,{get:()=>c}),client=accounts.client(c);client.on('error',()=>{});const abort=()=>client.close();options.signal?.addEventListener('abort',abort,{once:true});try{await client.connect();const since=loadRules(store.db).import_since;return await syncMail(store,c,client,dependencies().simpleParser,{since:since?new Date(since+'T00:00:00+03:00'):null,maxMessages:200,maxBytes:160*1024*1024,...options});}catch(e){if(e.disabled||options.signal?.aborted)throw e;const error=Error(safeMailError(e));error.needsLogin=Boolean(e.authenticationFailed);throw error;}finally{options.signal?.removeEventListener('abort',abort);try{await client.logout();}catch{client.close();}}}
