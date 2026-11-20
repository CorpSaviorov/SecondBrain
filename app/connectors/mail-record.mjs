import fs from 'node:fs';
import path from 'node:path';
import {hash,json} from '../store.mjs';
import {dependencies} from './mail-accounts.mjs';
import {loadRules,classifyMail,classifyOne} from '../lib/mail-filter.mjs';
export function storeMail(store,c,raw,parsed,{folder,uid,uidValidity,emailId}={}){
 const digest=hash(raw),external_id=emailId?'imap-id-'+emailId:'mime-sha256-'+digest,date=parsed.date instanceof Date&&Number.isFinite(parsed.date.getTime())?parsed.date.toISOString():null;
 const address=v=>(v?.value||[]).map(a=>({name:a.name||'',address:a.address||''}));
 const from=address(parsed.from),to=address(parsed.to),cc=address(parsed.cc),attachments=(parsed.attachments||[]).map(a=>({name:a.filename||'Вложение',mime:a.contentType||'application/octet-stream',bytes:a.content?.length||0,sha256:a.content?hash(a.content):null}));
 const text=typeof parsed.text==='string'&&parsed.text.length?parsed.text:typeof parsed.html==='string'?dependencies().htmlToText(parsed.html,{wordwrap:false}):'';
 const headers=[`Тема: ${parsed.subject||'Без темы'}`,`От: ${from.map(a=>a.address).join(', ')}`,`Кому: ${to.map(a=>a.address).join(', ')}`,...(cc.length?[`Копия: ${cc.map(a=>a.address).join(', ')}`]:[]),...(date?[`Дата: ${date}`]:[])].join('\n');
 const rules=loadRules(store.db),early=classifyMail({from:from[0]?.address,subject:parsed.subject,inReplyTo:parsed.inReplyTo,account:c.config.account},rules);
 if(early?.category==='code'&&!rules.store_codes)return {id:null,changed:false,skipped:'one-time-code'};
 const body=headers+'\n\n'+text+(attachments.length?'\n\nВложения:\n'+attachments.map(a=>a.name).join('\n'):'');
 const receipt=store.ingest({provider:'email',external_id,account:c.config.account,kind:'email',title:parsed.subject||'Без темы',body,messages:[{id:external_id,role:'email',text:body,...(date?{time:date}:{})}],source_date:date,date_basis:date?'email-date':'unknown',coverage:{saved_text:true,attachments_saved:attachments.length,attachments_read:false,html_executed:false},metadata:{service:c.config.service,from,to,cc,message_id:parsed.messageId||null,in_reply_to:parsed.inReplyTo||null,references:parsed.references||[],attachments,body_format:parsed.text?'mime-text-plain':'mime-html-to-text'}},{raw,transport:'direct-imap-readonly'});
 store.db.prepare('UPDATE raw_captures SET mime=? WHERE hash=?').run('message/rfc822',digest);
 store.db.exec('CREATE TABLE IF NOT EXISTS mail_locations(source_id TEXT NOT NULL,connector_id TEXT NOT NULL,folder TEXT NOT NULL,uid_validity TEXT NOT NULL,uid INTEGER NOT NULL,seen_at TEXT NOT NULL,PRIMARY KEY(connector_id,folder,uid_validity,uid));');
 store.db.prepare('INSERT OR REPLACE INTO mail_locations VALUES(?,?,?,?,?,?)').run(receipt.id,c.id,folder,String(uidValidity),uid,new Date().toISOString());
 const root=path.join(path.dirname(store.filename),'assets');
 for(const [index,a]of (parsed.attachments||[]).entries()){if(!Buffer.isBuffer(a.content))continue;const sha=hash(a.content);fs.mkdirSync(root,{recursive:true});const target=path.join(root,sha);if(!fs.existsSync(target))fs.writeFileSync(target,a.content,{flag:'wx'});const info=attachments[index];store.db.prepare('INSERT OR IGNORE INTO assets VALUES(?,?,?,?,?,?,?,?)').run(hash({source:receipt.id,index,sha}),receipt.id,info.name,target,info.mime,a.content.length,'saved-unread',json({sha256:sha,storage:'canonical-assets',service:c.config.service,content_id:a.contentId||null}));}
 classifyOne(store.db,store.db.prepare('SELECT id,title,account,metadata FROM sources WHERE id=?').get(receipt.id),rules);
 return receipt;
}
