import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {BrainStore} from './store.mjs';import {Notifier} from './notifier.mjs';import {Health} from './health.mjs';
const MIN=60000,HOUR=60*MIN;
function setup(){const s=new BrainStore(':memory:'),sent=[];let t=Date.parse('2026-11-27T10:00:00Z');const n=new Notifier(s,{send:async x=>{sent.push(x);return true;},now:()=>t,origin:'http://127.0.0.1:8877'});return {s,n,sent,at:()=>t,move:ms=>{t+=ms;}};}
const problem={key:'error:gmail',title:'Сбой',body:'Gmail',url:'#connections',graceMinutes:45,remindHours:24};

test('a problem is shown after its grace period, once, then reminded; a short blip stays silent',async()=>{const {n,sent,move,s}=setup();
 await n.update([problem]);assert.equal(sent.length,0,'not during the grace period');
 move(30*MIN);await n.update([]);move(30*MIN);await n.update([]);assert.equal(n.status().active.length,0,'gone for 30 minutes: solved, nothing was sent');
 await n.update([problem]);move(46*MIN);await n.update([problem]);assert.equal(sent.length,1);assert.equal(sent[0].url,'http://127.0.0.1:8877/#connections');assert.equal(sent[0].tag.length,16);
 move(2*HOUR);await n.update([problem]);assert.equal(sent.length,1,'no repeat before remindHours');
 move(23*HOUR);await n.update([problem]);assert.equal(sent.length,2,'reminded after a day');s.close();});

test('a flapping problem does not spam, a solved one that returns after a while is shown again',async()=>{const {n,sent,move,s}=setup(),p={key:'luna:blocked',title:'Пауза',body:'402',remindHours:24};
 await n.update([p]);assert.equal(sent.length,1);
 for(let i=0;i<6;i++){move(10*MIN);await n.update([]);move(10*MIN);await n.update([p]);}assert.equal(sent.length,1,'gaps under 20 minutes are the same episode');
 move(25*MIN);await n.update([]);assert.equal(n.status().active.length,0);move(HOUR);await n.update([p]);assert.equal(sent.length,1,'back within a day: the reminder time is kept');
 move(2*24*HOUR);await n.update([]);move(30*MIN);await n.update([p]);assert.equal(sent.length,2);s.close();});

test('a growing count is shown at once; switched off sends nothing',async()=>{const {n,sent,move,s}=setup(),r=v=>({key:'luna:review',version:v,title:'Проверка',body:v+' записей',remindHours:168});
 await n.update([r(1)]);await n.update([r(3)]);assert.deepEqual(sent.map(x=>x.body),['1 записей','3 записей']);
 await n.update([r(2)]);assert.equal(sent.length,3-1);await n.update([r(3)]);assert.equal(sent.length,3);
 n.configure({enabled:false});move(30*24*HOUR);await n.update([r(9),{...problem,graceMinutes:0}]);assert.equal(sent.length,3);
 assert.throws(()=>n.configure({enabled:'yes'}));s.close();});

test('health turns logins, errors, Luna, backups, the gateway and the disk into problems',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sb-health-')),backups=path.join(dir,'b'),gw=path.join(dir,'gw');fs.mkdirSync(backups);fs.mkdirSync(gw);
 const old=path.join(backups,'SecondBrain-backup-2026-11-01_13-00');fs.mkdirSync(old);const now=Date.parse('2026-11-27T10:00:00Z');fs.utimesSync(old,new Date(now-20*86400000),new Date(now-20*86400000));
 fs.writeFileSync(path.join(backups,'last-backup.log'),'SecondBrain: копирую\nОшибка копирования: нет места\n');fs.utimesSync(path.join(backups,'last-backup.log'),new Date(now-2*HOUR),new Date(now-2*HOUR));
 fs.writeFileSync(path.join(gw,'config.json'),JSON.stringify({origin:'https://example.ts.net',port:8787}));
 const registry={list:()=>[{id:'chatgpt',name:'ChatGPT',enabled:true,status:'needs-login',payload:{}},{id:'gmail',name:'Gmail',enabled:true,status:'error',payload:{message:'IMAP недоступен'}},{id:'off',name:'Off',enabled:false,status:'error',payload:{}}]};
 const cardWorker={status:()=>({blocked_reason:'Провайдер отклонил запрос (402): проверьте баланс',counts:{'needs-review':2}})},provider={config:()=>({automatic:true}),status:()=>({month:'2026-11'})};
 const urls=[];const h=new Health({registry,cardWorker,provider,storeDir:dir,backupDir:backups,gatewayDir:gw,now:()=>now,minFreeGb:1e9,fetchImpl:async u=>{urls.push(u);return {ok:!u.startsWith('https://')};}});
 const keys=(await h.problems()).map(p=>p.key);
 assert.deepEqual(keys,['login:chatgpt','error:gmail','luna:blocked','luna:review','backup:failed','backup:stale','gateway:public','disk:low']);
 const luna=(await h.problems()).find(p=>p.key==='luna:blocked');assert.equal(luna.graceMinutes,0);assert.equal(urls.filter(u=>u.startsWith('https://')).length,1,'public address checked at most every 15 minutes');
 const off=new Health({registry:{list:()=>[]},cardWorker,provider:{config:()=>({automatic:false})},storeDir:dir,backupDir:path.join(dir,'none'),gatewayDir:null,now:()=>now});
 assert.deepEqual(await off.problems(),[],'Luna switched off by the owner, no backup folder, no gateway: nothing to report');
 const down=new Health({registry:{list:()=>[]},cardWorker,provider:{config:()=>({automatic:false})},storeDir:dir,gatewayDir:gw,backupDir:null,fetchImpl:async()=>{throw Error('refused');}});
 assert.deepEqual((await down.problems()).map(p=>p.key),['gateway:local']);
 fs.rmSync(dir,{recursive:true,force:true});});
