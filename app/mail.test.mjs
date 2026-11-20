import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {BrainStore} from './store.mjs';
import {ConnectorRegistry} from './connectors/registry.mjs';
import {MailAccounts,dependencies,safeMailError} from './connectors/mail-accounts.mjs';
import {syncMail} from './connectors/imap-mail.mjs';
import {storeMail} from './connectors/mail-record.mjs';
const config={id:'email-gmail',provider:'email',driver:'imap-mail',config:{service:'gmail',account:'fixture@gmail.com',address:'fixture@gmail.com'}};
const makeStore=()=>new BrainStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(),'brain-mail-')),'brain.sqlite'));
const rawFor=n=>Buffer.from(`Message-ID: <${n}@fixture.test>\r\nFrom: Test <sender@fixture.test>\r\nTo: fixture@gmail.com\r\nSubject: Source ${n}\r\nDate: Fri, 13 Nov 2026 09:00:00 +0300\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nOriginal message ${n}.`);
test('Yandex grouped app passwords work on save and with already-saved legacy spacing',()=>{
 const s=makeStore(),r=new ConnectorRegistry(s);let sent;const a=new MailAccounts(s,r,{clientFactory:options=>{sent=options.auth.pass;return {};}});
 a.save('email-yandex',{address:'fixture@yandex.ru',password:'abcd efgh\u00a0ijkl mnop'});a.client(r.get('email-yandex'));assert.equal(sent,'abcdefghijklmnop');
 fs.writeFileSync(a.file('email-yandex'),JSON.stringify({address:'fixture@yandex.ru',password:'abcd efgh ijkl mnop'}));a.client(r.get('email-yandex'));assert.equal(sent,'abcdefghijklmnop');assert.equal(safeMailError({authenticationFailed:true,response:'Invalid credentials or IMAP is disabled'}),'Почта не приняла вход. Проверьте адрес, пароль приложения и доступ IMAP.');s.close();
});
class FakeIMAP{
 constructor(folders){this.folders=folders;this.commands=[];this.mailbox=null;}
 async list(){return Object.keys(this.folders).map(path=>({path,flags:new Set()}));}
 async getMailboxLock(folder,options){this.commands.push(['lock',folder,options]);this.folder=folder;const f=this.folders[folder];if(f.error)throw Error('folder error');this.mailbox={uidValidity:BigInt(f.validity||1),uidNext:f.next||Math.max(0,...f.uids)+1};return {release:()=>this.commands.push(['release'])};}
 async fetchAll(range,query,options){assert.equal(options.uid,true);this.commands.push(['metadata',range,query]);const [low,high]=range.split(':').map(Number);return this.folders[this.folder].uids.filter(n=>n>=low&&n<=high).map(uid=>({uid,size:this.folders[this.folder].oversize?30*1024*1024:rawFor(uid).length,emailId:String(uid)}));}
 async fetchOne(uid,query,options){assert.equal(options.uid,true);this.commands.push(['body',Number(uid),query]);return {uid:Number(uid),source:rawFor(uid),emailId:uid};}
}
test('MIME mail keeps source date, decoded original, raw bytes and owned attachments; copied labels do not duplicate',async()=>{
 const s=makeStore(),raw=Buffer.from('From: sender@example.com\r\nTo: fixture@gmail.com\r\nSubject: =?UTF-8?B?0J/RgNC+0LLQtdGA0LrQsA==?=\r\nDate: Fri, 13 Nov 2026 09:00:00 +0300\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="xyz"\r\n\r\n--xyz\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>Проверка рефакторинга. Точная цитата.</p>\r\n--xyz\r\nContent-Type: text/plain\r\nContent-Disposition: attachment; filename="../../original.txt"\r\nContent-Transfer-Encoding: base64\r\n\r\nSGVsbG8=\r\n--xyz--\r\n');
 const p=await dependencies().simpleParser(raw,{skipTextToHtml:true});const r=storeMail(s,config,raw,p,{folder:'INBOX',uid:1,uidValidity:1,emailId:'global'});storeMail(s,config,raw,p,{folder:'All Mail',uid:8,uidValidity:5,emailId:'global'});
 assert.equal(s.stats().sources,1);assert.equal(s.search('рефакторингу').total,1);const d=s.db.prepare('SELECT * FROM sources').get();assert.equal(d.source_date,'2026-11-13T06:00:00.000Z');assert.equal(d.kind,'email');assert.equal(s.db.prepare('SELECT count(*) n FROM mail_locations').get().n,2);assert.deepEqual(s.db.prepare('SELECT payload FROM raw_captures').get().payload,Uint8Array.from(raw));const a=s.db.prepare('SELECT * FROM assets').get();assert.equal(fs.readFileSync(a.path,'utf8'),'Hello');assert.ok(a.path.startsWith(path.join(path.dirname(s.filename),'assets')));assert.equal(r.changed,true);assert.equal(s.stats().assets,1);s.close();
});
test('newest-first bounded UID checkpoints resume without gaps; new arrivals are read alongside backfill',async()=>{
 const s=makeStore(),client=new FakeIMAP({INBOX:{uids:[1,2,3,4,5,6]}}),parse=dependencies().simpleParser;
 let r=await syncMail(s,config,client,parse,{maxMessages:2});assert.equal(r.captured,2);assert.equal(r.catalog_scan_complete,false);assert.deepEqual(client.commands.filter(c=>c[0]==='body').map(c=>c[1]),[6,5]);
 client.folders.INBOX.uids.push(7,8);await syncMail(s,config,client,parse,{maxMessages:2});assert.deepEqual(client.commands.filter(c=>c[0]==='body').map(c=>c[1]),[6,5,7,8]);
 for(let i=0;i<3;i++)r=await syncMail(s,config,client,parse,{maxMessages:2});assert.equal(r.catalog_scan_complete,true);assert.equal(s.stats().sources,8);assert.ok(client.commands.filter(c=>c[0]==='lock').every(c=>c[2].readOnly===true));assert.ok(client.commands.filter(c=>c[0]==='body').every(c=>c[2].source===true));s.close();
});
test('UIDVALIDITY resets only the folder cursor and replays idempotently',async()=>{
 const s=makeStore(),client=new FakeIMAP({INBOX:{uids:[1,2]}});await syncMail(s,config,client,dependencies().simpleParser);client.folders.INBOX.validity=2;client.folders.INBOX.uids.push(3);const r=await syncMail(s,config,client,dependencies().simpleParser);assert.equal(r.captured,3);assert.equal(r.changed,1);assert.equal(s.stats().sources,3);s.close();
});
test('turning off a mail source during body fetch prevents ingestion and cursor advance',async()=>{
 const s=makeStore(),client=new FakeIMAP({INBOX:{uids:[1]}});let enabled=true;const original=client.fetchOne.bind(client);client.fetchOne=async(...args)=>{const v=await original(...args);enabled=false;return v;};await assert.rejects(()=>syncMail(s,config,client,dependencies().simpleParser,{isEnabled:()=>enabled}),/disabled/);assert.equal(s.stats().sources,0);assert.equal(s.db.prepare('SELECT count(*) n FROM mail_checkpoints').get().n,0);s.close();
});
test('MIME error cannot advance past lost mail; replay keeps prior receipt idempotent',async()=>{
 const s=makeStore(),client=new FakeIMAP({INBOX:{uids:[1,2]}});let calls=0;const r=await syncMail(s,config,client,async(raw,opts)=>{if(++calls===2)throw Error('bad MIME');return dependencies().simpleParser(raw,opts);});assert.equal(r.errors.length,1);assert.equal(s.stats().sources,1);assert.equal(s.db.prepare('SELECT count(*) n FROM mail_checkpoints').get().n,0);await syncMail(s,config,client,dependencies().simpleParser);assert.equal(s.stats().sources,2);s.close();
});
test('oversized mail is explicitly deferred without body download; broken folder does not stop another',async()=>{
 const s=makeStore(),client=new FakeIMAP({Broken:{uids:[],error:true},Large:{uids:[1],oversize:true},Normal:{uids:[2]}});const r=await syncMail(s,config,client,dependencies().simpleParser);assert.equal(r.deferred,1);assert.equal(r.errors.length,1);assert.equal(r.captured,1);assert.equal(client.commands.filter(c=>c[0]==='body').length,1);s.close();
});
test('mail settings keep app password outside DB/API, lock account namespace, isolate disabling',async()=>{
 const s=makeStore(),registry=new ConnectorRegistry(s);let connection;const accounts=new MailAccounts(s,registry,{clientFactory:options=>{connection=options;return {on(){},async connect(){},async list(){return [{path:'INBOX',flags:new Set()}];},async logout(){}};}});
 assert.throws(()=>accounts.save('email-gmail',{address:'Fixture@gmail.com',password:'MyGoogle9'}),/16 латинских букв/);accounts.save('email-gmail',{address:'Fixture@gmail.com',password:'abcd efgh ijkl mnop'});assert.deepEqual(await accounts.check('email-gmail'),{id:'email-gmail',service:'gmail',address:'fixture@gmail.com',password_saved:true,enabled:true,ok:true,folders:1,message:'Вход выполнен. Найдено папок: 1'});assert.equal(connection.auth.pass,'abcdefghijklmnop');assert.equal(connection.secure,true);assert.equal(connection.port,993);assert.equal(connection.logger,false);assert.ok(!JSON.stringify(registry.list()).includes('abcdefghijklmnop'));
 const parsed=await dependencies().simpleParser(rawFor(1));storeMail(s,registry.get('email-gmail'),rawFor(1),parsed,{folder:'INBOX',uid:1,uidValidity:1});assert.throws(()=>accounts.save('email-gmail',{address:'other@gmail.com',password:'new'}),/другого адреса/);registry.configure('email-gmail',{enabled:false});assert.equal(registry.get('email-yandex').enabled,false);assert.equal(s.stats().sources,1);assert.equal(registry.accepts('email',{account:'fixture@gmail.com'}),false);assert.equal((await registry.collect('email-gmail')).skipped,'disabled');assert.ok(!safeMailError(Error('secret app pass test')).includes('secret'));s.close();
});
test('Spam and Trash folders are not imported (by special-use flag or by name)',async()=>{
 const s=makeStore(),client=new FakeIMAP({INBOX:{uids:[1]},'[Gmail]/Спам':{uids:[2]},Trash:{uids:[3]},Junk:{uids:[4]}});
 client.list=async()=>[{path:'INBOX',flags:new Set()},{path:'[Gmail]/Спам',flags:new Set(),specialUse:'\Junk'},{path:'Trash',flags:new Set()},{path:'Junk',flags:new Set()}];
 const r=await syncMail(s,config,client,dependencies().simpleParser);assert.equal(r.captured,1);assert.deepEqual(client.commands.filter(c=>c[0]==='lock').map(c=>c[1]),['INBOX']);assert.equal(r.catalog_scan_complete,true);});
test('date limit: history older than import_since is never read, newer mail and new arrivals are',async()=>{
 const s=makeStore(),client=new FakeIMAP({INBOX:{uids:[1,2,3,4,5,6]}});client.search=async q=>{assert.ok(q.since instanceof Date);return [4,5,6];};
 let r=await syncMail(s,config,client,dependencies().simpleParser,{since:new Date('2026-11-01T00:00:00+03:00')});assert.equal(r.captured,3);assert.equal(r.catalog_scan_complete,true);
 assert.deepEqual(client.commands.filter(c=>c[0]==='body').map(c=>c[1]).sort(),[4,5,6]);
 client.folders.INBOX.uids.push(7);r=await syncMail(s,config,client,dependencies().simpleParser,{since:new Date('2026-11-01T00:00:00+03:00')});assert.deepEqual(client.commands.filter(c=>c[0]==='body').map(c=>c[1]).sort(),[4,5,6,7]);
 const empty=makeStore(),c2=new FakeIMAP({Old:{uids:[1,2]}});c2.search=async()=>[];r=await syncMail(empty,config,c2,dependencies().simpleParser,{since:new Date('2026-11-01')});assert.equal(r.captured,0);assert.equal(r.catalog_scan_complete,true);});
