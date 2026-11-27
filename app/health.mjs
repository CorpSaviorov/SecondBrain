// Current problems worth a Windows notification (owner, 2026-11-27): source logins and collection errors, Luna stopped
// or out of budget, records waiting for manual review, backups failed or overdue, ChatGPT/Claude access (the gateway and
// its public address) and disk space. Only facts the system already records; no model calls.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const short=(s,n=150)=>{const v=String(s||'').replace(/\s+/g,' ').trim();return v.length>n?v.slice(0,n-1)+'…':v;};
const plural=(n,one,few,many)=>{const a=Math.abs(n)%100,b=a%10;return a>10&&a<20?many:b>1&&b<5?few:b===1?one:many;};
const day=ms=>new Date(ms).toLocaleDateString('ru-RU',{day:'numeric',month:'long',timeZone:'Europe/Moscow'});
export class Health{
 constructor({registry,cardWorker,provider,storeDir,backupDir=process.env.BRAIN_BACKUP_DIR||path.join(os.homedir(),'SecondBrain-Backups'),gatewayDir=process.env.BRAIN_GATEWAY_DIR||null,fetchImpl=fetch,now=()=>Date.now(),minFreeGb=10}){
  Object.assign(this,{registry,cardWorker,provider,storeDir,backupDir,gatewayDir,fetch:fetchImpl,now,minFreeGb});this.publicCheck={at:0,ok:true};
 }
 async problems(){return [...this.sources(),...this.luna(),...this.backups(),...await this.gateway(),...this.disk()];}
 sources(){const out=[];
  for(const c of this.registry.list()){if(!c.enabled)continue;
   if(c.status==='needs-login')out.push({key:'login:'+c.id,title:'Второй мозг: нужен вход — '+c.name,body:'Сбор «'+c.name+'» остановлен, пока вы снова не войдёте. Откройте «Источники».',url:'#connections',remindHours:24});
   else if(c.status==='error')out.push({key:'error:'+c.id,title:'Второй мозг: не удаётся собрать «'+c.name+'»',body:short(c.payload?.message||c.payload?.error||'Сбор завершается ошибкой. Подробности — в «Источниках».'),url:'#connections',graceMinutes:45,remindHours:24});}
  return out;}
 luna(){const out=[];if(!this.provider.config().automatic)return out;
  const st=this.cardWorker.status(),reason=st.blocked_reason;
  if(reason){
   if(/недоступен по сети/.test(reason))out.push({key:'luna:outage',title:'Второй мозг: Luna не может связаться с провайдером',body:'Карточки на паузе из-за сбоя связи и продолжатся сами. Если это длится долго, проверьте интернет.',url:'#processing',graceMinutes:60,remindHours:12});
   else if(/лимит/i.test(reason))out.push({key:'luna:budget:'+this.provider.status().month,title:'Второй мозг: месячный лимит Luna исчерпан',body:'Новые записи ждут карточек до следующего месяца. Лимит можно поднять в «Настройках».',url:'#model',remindHours:24*7});
   else out.push({key:'luna:blocked',title:'Второй мозг: обработка карточек остановлена',body:short(reason),url:'#processing',graceMinutes:/отклонил/.test(reason)?0:30,remindHours:24});}
  const review=st.counts?.['needs-review']||0;
  if(review)out.push({key:'luna:review',version:review,title:'Второй мозг: записи ждут проверки',body:review+' '+plural(review,'запись ждёт','записи ждут','записей ждут')+' ручной проверки в «Обработке».',url:'#processing',remindHours:24*7});
  return out;}
 backups(){const dir=this.backupDir,out=[];if(!dir||!fs.existsSync(dir))return out;
  const now=this.now(),folders=fs.readdirSync(dir).filter(n=>/^SecondBrain-backup-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}$/.test(n)).sort(),last=folders.at(-1),lastAt=last?fs.statSync(path.join(dir,last)).mtimeMs:0;
  const log=path.join(dir,'last-backup.log');
  if(fs.existsSync(log)){const at=fs.statSync(log).mtimeMs,text=fs.readFileSync(log,'utf8');
   // A newer log without «Готово» that stopped changing half an hour ago: the last run failed.
   if(at>lastAt+60000&&!/Готово:/.test(text)&&now-at>30*60000){const line=text.split(/\r?\n/).map(s=>s.trim()).filter(Boolean).at(-1)||'';
    out.push({key:'backup:failed',title:'Второй мозг: резервная копия не сделана',body:short('Последний запуск ('+day(at)+') завершился ошибкой'+(line?': '+line:'.')),remindHours:24});}}
  if(last&&now-lastAt>9*86400000)out.push({key:'backup:stale',title:'Второй мозг: резервная копия давно не делалась',body:'Последняя копия — '+day(lastAt)+'. Проверьте, что резервное копирование работает.',remindHours:72});
  return out;}
 async ping(url,ms){try{const r=await this.fetch(url,{signal:AbortSignal.timeout(ms)});return r.ok;}catch{return false;}}
 // The gateway that lets ChatGPT and Claude read the base: local port, and its public address every 15 minutes.
 async gateway(){const dir=this.gatewayDir,out=[];if(!dir)return out;let cfg;try{cfg=JSON.parse(fs.readFileSync(path.join(dir,'config.json'),'utf8'));}catch{return out;}
  if(!await this.ping('http://127.0.0.1:'+(Number(cfg.port)||8787)+'/.well-known/oauth-authorization-server',5000)){
   out.push({key:'gateway:local',title:'Второй мозг: ChatGPT и Claude не видят базу',body:'Шлюз для ChatGPT и Claude не отвечает. Запустите его снова: npm run gateway (или задача автозапуска шлюза).',graceMinutes:15,remindHours:24});return out;}
  if(cfg.origin){const now=this.now();if(now-this.publicCheck.at>=15*60000)this.publicCheck={at:now,ok:await this.ping(String(cfg.origin).replace(/\/$/,'')+'/.well-known/oauth-authorization-server',12000)};
   if(!this.publicCheck.ok)out.push({key:'gateway:public',title:'Второй мозг: база недоступна снаружи',body:'Шлюз работает, но его адрес для ChatGPT и Claude не открывается. Проверьте интернет и Tailscale (tailscale funnel status).',graceMinutes:30,remindHours:24});}
  return out;}
 disk(){try{const s=fs.statfsSync(this.storeDir),gb=s.bavail*s.bsize/1024**3;
  if(gb<this.minFreeGb)return [{key:'disk:low',title:'Второй мозг: мало места на диске',body:'Свободно '+gb.toFixed(1).replace('.',',')+' ГБ на диске с базой. База и резервные копии растут — освободите место.',remindHours:24}];}catch{}
  return [];}
}
