const CHANNEL='secondbrain-local-v1';
window.addEventListener('message',async event=>{
 if(event.source!==window||event.data?.channel!==CHANNEL)return;
 if(event.data.type==='capture'||event.data.type==='known'){
  const result=await chrome.runtime.sendMessage(event.data.type==='capture'?{type:'capture',packet:event.data.packet}:{type:'known',provider:event.data.provider});
  window.postMessage({channel:CHANNEL,type:'receipt',request:event.data.request,result},location.origin);
 }
 if(event.data.type==='progress')chrome.runtime.sendMessage({type:'progress',message:event.data.message,ok:event.data.ok});
});
chrome.runtime.onMessage.addListener((message,sender,respond)=>{
 if(message.type==='run'){window.postMessage({channel:CHANNEL,type:'command',action:message.action},location.origin);respond({ok:true,started:true});}
});
// Collection uses an existing signed-in tab. It does not open new logins or use a model.
setInterval(()=>window.postMessage({channel:CHANNEL,type:'command',action:'recent'},location.origin),30*60*1000);
