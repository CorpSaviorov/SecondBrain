// Windows notifications about failures (owner, 2026-11-27). Every 5 minutes the server collects current problems
// (health.mjs) and this module decides what to show:
//  - a problem is shown once it has lasted its grace period (short blips stay silent);
//  - it is repeated only after remindHours, also when it flaps (absent for less than 20 minutes does not count as solved);
//  - a growing count (records waiting for review) is shown again at once;
//  - a solved problem is closed quietly. Nothing is sent when the owner switched notifications off.
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const SCRIPT=fileURLToPath(new URL('./tools/notify.ps1',import.meta.url));
const RESOLVE_AFTER_MIN=20;
// Shows a toast through Windows PowerShell 5.1 (WinRT). Text travels as base64 JSON, never through the command line.
export function sendToast({title,body,url,tag}){
 return new Promise(resolve=>{
  if(process.platform!=='win32')return resolve(false);
  const payload=Buffer.from(JSON.stringify({title,body,url,tag,app:'Второй мозг'}),'utf8').toString('base64');
  const ps=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  let child;try{child=spawn(ps,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',SCRIPT,'-Payload',payload],{windowsHide:true,stdio:'ignore'});}catch{return resolve(false);}
  const timer=setTimeout(()=>{try{child.kill();}catch{}resolve(false);},30000);
  child.on('exit',code=>{clearTimeout(timer);resolve(code===0);});child.on('error',()=>{clearTimeout(timer);resolve(false);});
 });
}
export class Notifier{
 constructor(store,{send=sendToast,now=()=>Date.now(),origin='http://127.0.0.1:8877'}={}){
  this.store=store;this.send=send;this.now=now;this.origin=origin;
  store.db.exec('CREATE TABLE IF NOT EXISTS notification_state(key TEXT PRIMARY KEY,active INTEGER NOT NULL,version INTEGER NOT NULL DEFAULT 0,first_seen TEXT NOT NULL,last_seen TEXT NOT NULL,last_sent TEXT,title TEXT NOT NULL,body TEXT NOT NULL,url TEXT)');
 }
 settings(){const r=this.store.db.prepare("SELECT value FROM brain_meta WHERE key='notifications'").get();let v={};try{v=JSON.parse(r?.value||'{}');}catch{}return {enabled:v.enabled!==false};}
 configure({enabled}={}){if(typeof enabled!=='boolean')throw Error('Укажите, включены ли уведомления');this.store.db.prepare("INSERT INTO brain_meta VALUES('notifications',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify({enabled}));return this.status();}
 status(){return {...this.settings(),supported:process.platform==='win32',active:this.store.db.prepare('SELECT key,title,body,url,first_seen,last_sent FROM notification_state WHERE active=1 ORDER BY first_seen').all()};}
 link(url){return url?.startsWith('#')?this.origin+'/'+url:url||this.origin+'/';}
 toast(p){return this.send({title:p.title,body:p.body,url:this.link(p.url),tag:createHash('sha1').update(p.key).digest('hex').slice(0,16)});}
 // problems: [{key,title,body,url?,graceMinutes?,remindHours?,version?}]
 async update(problems){
  const now=this.now(),iso=new Date(now).toISOString(),db=this.store.db,get=db.prepare('SELECT * FROM notification_state WHERE key=?'),enabled=this.settings().enabled,sent=[],present=new Set();
  for(const p of problems){present.add(p.key);const version=Number(p.version)||0;let row=get.get(p.key);
   if(!row)db.prepare('INSERT INTO notification_state VALUES(?,1,?,?,?,NULL,?,?,?)').run(p.key,version,iso,iso,p.title,p.body,p.url||null);
   // Back after being solved: a new episode, but the last reminder time is kept, so a flapping problem cannot spam.
   else if(!row.active)db.prepare('UPDATE notification_state SET active=1,version=?,first_seen=?,last_seen=?,title=?,body=?,url=? WHERE key=?').run(version,iso,iso,p.title,p.body,p.url||null,p.key);
   else db.prepare('UPDATE notification_state SET last_seen=?,title=?,body=?,url=? WHERE key=?').run(iso,p.title,p.body,p.url||null,p.key);
   row=get.get(p.key);
   if(version<row.version)db.prepare('UPDATE notification_state SET version=? WHERE key=?').run(version,p.key);
   const grew=version>row.version,lasted=(now-Date.parse(row.first_seen))/60000,since=row.last_sent?(now-Date.parse(row.last_sent))/3600000:Infinity;
   if(!enabled||lasted<(p.graceMinutes||0))continue;
   if((grew||since>=(p.remindHours??24))&&await this.toast(p)){db.prepare('UPDATE notification_state SET last_sent=?,version=? WHERE key=?').run(iso,version,p.key);sent.push(p.key);}
  }
  for(const r of db.prepare('SELECT key,last_seen FROM notification_state WHERE active=1').all())
   if(!present.has(r.key)&&now-Date.parse(r.last_seen)>=RESOLVE_AFTER_MIN*60000)db.prepare('UPDATE notification_state SET active=0 WHERE key=?').run(r.key);
  return {sent,active:db.prepare('SELECT count(*) n FROM notification_state WHERE active=1').get().n};
 }
 async test(){return {sent:await this.toast({key:'test',title:'Второй мозг: уведомления работают',body:'Так будут приходить сообщения о сбоях. Нажмите, чтобы открыть панель.',url:'#model'})};}
}
