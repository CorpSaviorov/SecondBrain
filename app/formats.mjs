import {hash,json,sourceKey} from './store.mjs';
const time=v=>typeof v==='number'?new Date(v<1e12?v*1000:v).toISOString():typeof v==='string'?v:null;
export const transcript=messages=>messages.map(m=>`## ${m.role} · ${m.id}\n${m.time?'Дата: '+m.time+'\n':''}\n${m.text}`).join('\n\n');
const unique=messages=>{const byId=new Map();for(const m of messages){if(!m.id)throw Error('Message lacks stable identity');if(byId.has(m.id)&&json(byId.get(m.id))!==json(m))throw Error('Message changed between overlapping pages');byId.set(m.id,m);}return [...byId.values()];};
const textParts=c=>typeof c==='string'?c:Array.isArray(c)?c.map(p=>typeof p==='string'?p:p&&typeof p.text==='string'?p.text:'').filter(Boolean).join('\n\n'):'';

export function chatgptRecord(value,{account='personal',source_path,aliases=[],coverage={},title,external_id}={}){
 let entries=value.messages;
 if(value.mapping){
  const nodes=value.mapping;
  if(value.current_node){const chain=[],seen=new Set();let id=value.current_node;while(id){if(seen.has(id)||!nodes[id])throw Error('Broken ChatGPT branch');seen.add(id);chain.unshift(nodes[id]);id=nodes[id].parent;}entries=chain.map(n=>n.message).filter(Boolean);}
  else {entries=Object.values(nodes).map(n=>n.message).filter(Boolean);coverage={...coverage,branch_selection:'all exported messages; active leaf unavailable'};}
 }
 if(!Array.isArray(entries))throw Error('Unknown ChatGPT message format');
 const messages=unique(entries.filter(m=>m&&['user','assistant','system','tool'].includes(m.author?.role||m.role)).map(m=>({id:m.id,role:m.author?.role||m.role,text:textParts(m.content?.parts)||m.content?.text||m.text||'',time:time(m.create_time||m.time)})));
 const id=value.conversation_id||value.id||external_id;if(!id)throw Error('ChatGPT conversation identity unavailable');
 return {provider:'chatgpt',external_id:id,account,title:title||value.title||'Без названия',messages,body:transcript(messages),source_path,aliases,
  source_date:time(value.update_time),date_basis:'source-updated',coverage:{saved_text:true,all_branches_verified:false,attachments_read:false,...(value.page_info?.has_previous_page?{partial:true,reason:'older pages not included'}:{}),...coverage},metadata:{project:value.gizmo_id||null,...(value._secondbrain_project_name?{project_name:value._secondbrain_project_name}:{}),nontext_messages:entries.filter(m=>m?.content?.parts?.some?.(p=>typeof p!=='string')).length}};
}
export function claudeRecord(value,{account='personal',source_path,aliases=[],title,coverage={}}={}){
 if(!Array.isArray(value.chat_messages))throw Error('Unknown Claude conversation format');
 const messages=unique(value.chat_messages.map(m=>({id:m.uuid||m.id,role:m.sender==='human'?'user':m.sender==='assistant'?'assistant':m.role||'system',text:textParts(m.content)||m.text||'',time:time(m.created_at)})));
 if(!value.uuid&&!value.id)throw Error('Claude conversation identity unavailable');
 return {provider:'claude',external_id:value.uuid||value.id,account,title:title||value.name||'Без названия',messages,body:transcript(messages),source_path,aliases,source_date:time(value.updated_at),date_basis:'source-updated',coverage:{saved_text:true,all_branches_verified:false,attachments_read:false,...coverage},metadata:{project:value.project_uuid||null,...(value._secondbrain_project_name?{project_name:value._secondbrain_project_name}:{})}};
}
export function emailRecord(v){
 const id=v.message_id||v.id;if(!id||typeof v.body!=='string')throw Error('Email needs stable message_id and body');
 return {provider:'email',external_id:id,account:v.account||'personal',kind:'email',title:v.subject||'Без темы',messages:[{id,role:'email',text:v.body,time:time(v.date)}],body:v.body,source_date:time(v.date),date_basis:'email-date',coverage:{saved_text:true,attachments_read:false},metadata:{from:v.from||null,to:v.to||null,folder:v.folder||null}};
}
export function importPayload(store,value,{provider,account='personal',transport='direct',allowProvider=()=>true}={}){
 const values=Array.isArray(value)?value:[value],results=[];
 for(const raw of values){let record;
  if(provider==='chatgpt'||raw.mapping||raw.conversation_id)record=chatgptRecord(raw,{account});
  else if(provider==='claude'||raw.chat_messages)record=claudeRecord(raw,{account});
  else if(provider==='email')record=emailRecord(raw);
  else if(raw.schema==='secondbrain-source-v1')record=raw;
  else throw Error('Choose ChatGPT, Claude or email input format');
  if(!allowProvider(record.provider,record.account||account)){const error=Error('Источник отключён или аккаунт не подключён: '+record.provider);error.statusCode=409;throw error;}
  if(transport.startsWith('direct')&&record.coverage?.partial){const id=sourceKey(record.provider,record.external_id,record.account);store.db.prepare("DELETE FROM pending_captures WHERE source_id=? AND raw_hash<>? AND NOT EXISTS(SELECT 1 FROM pending_capture_resolutions r WHERE r.source_id=pending_captures.source_id AND r.raw_hash=pending_captures.raw_hash)").run(id,hash(raw));store.db.prepare('INSERT OR IGNORE INTO pending_captures VALUES(?,?,?,?,?)').run(id,hash(raw),json(raw),'incomplete-chat-pages',new Date().toISOString());results.push({id,changed:false,pending:true,reason:'incomplete-chat-pages'});}
  else {const receipt=store.ingest(record,{raw,transport});results.push(receipt);
   if(['chatgpt','claude'].includes(record.provider)&&!record.coverage.partial){const completeDate=Date.parse(record.source_date||'');if(Number.isFinite(completeDate))for(const pending of store.db.prepare('SELECT raw_hash,payload FROM pending_captures WHERE source_id=?').all(receipt.id)){const p=JSON.parse(pending.payload),date=p.updated_at||p.update_time,value=Date.parse(time(date)??'');if(Number.isFinite(value)&&value<=completeDate){store.db.prepare('INSERT OR IGNORE INTO pending_capture_resolutions VALUES(?,?,?,?)').run(receipt.id,pending.raw_hash,receipt.revision,new Date().toISOString());store.db.prepare('DELETE FROM pending_captures WHERE source_id=? AND raw_hash=?').run(receipt.id,pending.raw_hash);}}}
  }
 }
 return {imported:results.filter(r=>!r.pending).length,pending:results.filter(r=>r.pending).length,changed:results.filter(r=>r.changed).length,results};
}


export function resolvePendingCaptures(store){
 let resolved=0;
 for(const p of store.db.prepare('SELECT p.source_id,p.raw_hash,p.payload,s.revision,s.source_date,s.coverage FROM pending_captures p JOIN sources s ON s.id=p.source_id WHERE NOT EXISTS(SELECT 1 FROM pending_capture_resolutions r WHERE r.source_id=p.source_id AND r.raw_hash=p.raw_hash)').all()){
  if(JSON.parse(p.coverage).partial)continue;const raw=JSON.parse(p.payload),date=raw.updated_at||raw.update_time,value=Date.parse(time(date)??''),complete=Date.parse(p.source_date||'');
  if(Number.isFinite(value)&&Number.isFinite(complete)&&value<=complete){store.db.prepare('INSERT OR IGNORE INTO pending_capture_resolutions VALUES(?,?,?,?)').run(p.source_id,p.raw_hash,p.revision,new Date().toISOString());store.db.prepare('DELETE FROM pending_captures WHERE source_id=? AND raw_hash=?').run(p.source_id,p.raw_hash);resolved++;}
 }return resolved;
}
