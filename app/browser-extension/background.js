const endpoint='http://127.0.0.1:8877';
let serial=Promise.resolve();
async function flush(){
 const state=await chrome.storage.local.get(['outbox']),outbox=state.outbox||{};let sent=0;
 for(const [key,packet]of Object.entries(outbox)){
  const r=await fetch(endpoint+'/api/ingest',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(packet)});
  if(!r.ok){const v=await r.json();throw Error(v.error||'Локальный приёмник отклонил пакет');}
  const v=await r.json();if(v.pending)throw Error('Разговор сохранён как неполный пакет; нужны остальные страницы');
  delete outbox[key];await chrome.storage.local.set({outbox});sent++;
 }
 return sent;
}
chrome.runtime.onMessage.addListener((message,sender,respond)=>{
 serial=serial.catch(()=>{}).then(async()=>{
  if(message.type==='capture'){
   if(!sender.tab?.url||!/^https:\/\/(chatgpt\.com|claude\.ai)\//.test(sender.tab.url))throw Error('Неизвестный источник');
   const state=await chrome.storage.local.get(['outbox']),outbox=state.outbox||{},raw=message.packet.data,id=raw.conversation_id||raw.uuid||raw.id;
   if(!id)throw Error('Нет ID разговора');
   outbox[message.packet.provider+':'+id]=message.packet;
   if(JSON.stringify(outbox).length>8*1024*1024)throw Error('Очередь расширения заполнена: сначала запустите локальный SecondBrain');
   await chrome.storage.local.set({outbox});
   const sent=await flush();await chrome.storage.local.set({last:{ok:true,time:new Date().toISOString(),sent}});return {ok:true,sent};
  }
  if(message.type==='flush')return {ok:true,sent:await flush()};
  if(message.type==='known'){const r=await fetch(endpoint+'/api/known?provider='+encodeURIComponent(message.provider));if(!r.ok)throw Error('Нет связи с локальной БД');return {ok:true,...await r.json()};}
  if(message.type==='status'){const s=await chrome.storage.local.get(['last','outbox']);let online=false;try{const r=await fetch(endpoint+'/api/stats');online=r.ok;}catch{}return {ok:true,online,last:s.last,pending:Object.keys(s.outbox||{}).length};}
  if(message.type==='progress'){await chrome.storage.local.set({last:{ok:message.ok!==false,time:new Date().toISOString(),message:message.message}});return {ok:true};}
  return {ok:false,error:'Неизвестная команда'};
 });
 serial.then(respond,e=>{chrome.storage.local.set({last:{ok:false,time:new Date().toISOString(),message:e.message}});respond({ok:false,error:e.message});});return true;
});
