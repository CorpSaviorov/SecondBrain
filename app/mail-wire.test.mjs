import {test} from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {BrainStore} from './store.mjs';
import {dependencies} from './connectors/mail-accounts.mjs';
import {syncMail} from './connectors/imap-mail.mjs';
test('real IMAP client uses EXAMINE and UID BODY.PEEK; never mutates flags or mailbox',async()=>{
 const raw=Buffer.from('From: sender@fixture.test\r\nTo: inbox@fixture.test\r\nSubject: Wire fixture\r\nDate: Fri, 13 Nov 2026 09:00:00 +0300\r\n\r\nLiteral source from read-only IMAP.'),commands=[],sockets=new Set();
 const server=net.createServer(socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.write('* OK fixture IMAP ready\r\n');let input='';socket.on('data',chunk=>{input+=chunk.toString();let at;while((at=input.indexOf('\r\n'))>=0){const line=input.slice(0,at);input=input.slice(at+2);commands.push(line);const [tag,...parts]=line.split(' '),verb=parts[0].toUpperCase(),ok=()=>socket.write(tag+' OK done\r\n');
  if(verb==='CAPABILITY'){socket.write('* CAPABILITY IMAP4rev1\r\n');ok();}
  else if(verb==='LOGIN'||verb==='ID')ok();
  else if(verb==='LIST'||verb==='LSUB'){socket.write('* '+verb+' () "/" "INBOX"\r\n');ok();}
  else if(verb==='EXAMINE'){socket.write('* FLAGS (\\Seen)\r\n* 1 EXISTS\r\n* OK [UIDVALIDITY 7] stable\r\n* OK [UIDNEXT 2] next\r\n');socket.write(tag+' OK [READ-ONLY] opened\r\n');}
  else if(verb==='UID'&&parts[1].toUpperCase()==='FETCH'){if(line.includes('BODY.PEEK')){socket.write(`* 1 FETCH (UID 1 BODY[] {${raw.length}}\r\n`);socket.write(raw);socket.write(')\r\n');}else socket.write(`* 1 FETCH (UID 1 RFC822.SIZE ${raw.length})\r\n`);ok();}
  else if(verb==='LOGOUT'){socket.write('* BYE done\r\n');ok();socket.end();}
  else socket.write(tag+' BAD unexpected command\r\n');
 }});});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const client=new (dependencies().ImapFlow)({host:'127.0.0.1',port:server.address().port,secure:false,doSTARTTLS:false,auth:{user:'inbox@fixture.test',pass:'synthetic-only'},logger:false,disableAutoIdle:true,connectionTimeout:2000,socketTimeout:2000});client.on('error',()=>{});const store=new BrainStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(),'brain-mail-wire-')),'brain.sqlite'));
 try{await client.connect();const result=await syncMail(store,{id:'email-gmail',config:{service:'gmail',account:'inbox@fixture.test'}},client,dependencies().simpleParser);assert.equal(result.captured,1);assert.equal(result.errors.length,0);assert.equal(store.search('Literal').total,1);await client.logout();assert.ok(commands.some(c=>/ EXAMINE /.test(c)));assert.ok(commands.some(c=>/ UID FETCH .*BODY\.PEEK\[\]/.test(c)));assert.ok(!commands.some(c=>/ (STORE|APPEND|MOVE|COPY|EXPUNGE|SELECT|DELETE|CREATE) /i.test(c)));}finally{client.close();store.close();for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));}
});
