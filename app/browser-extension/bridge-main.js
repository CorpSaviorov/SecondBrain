(()=>{
 const CHANNEL='secondbrain-local-v1',provider=location.hostname==='chatgpt.com'?'chatgpt':'claude',fetchOriginal=window.fetch.bind(window),pending=new Map();
 let token=null,busy=false,cooldown=0;
 const report=(message,ok=true)=>window.postMessage({channel:CHANNEL,type:'progress',message,ok},location.origin);
 const sleep=ms=>new Promise(r=>setTimeout(r,ms));
 window.addEventListener('message',event=>{
  if(event.source!==window||event.data?.channel!==CHANNEL)return;
  if(event.data.type==='receipt'){const waiter=pending.get(event.data.request);if(waiter){pending.delete(event.data.request);event.data.result?.ok?waiter.resolve(event.data.result):waiter.reject(Error(event.data.result?.error||'Нет подтверждения записи'));}}
  if(event.data.type==='command')run(event.data.action).catch(e=>report(e.message,false));
 });
 const deliver=data=>new Promise((resolve,reject)=>{const request=crypto.randomUUID(),timer=setTimeout(()=>{pending.delete(request);reject(Error('Нет ответа от расширения'));},30000);pending.set(request,{resolve:v=>{clearTimeout(timer);resolve(v);},reject:e=>{clearTimeout(timer);reject(e);}});window.postMessage({channel:CHANNEL,type:'capture',request,packet:{provider,data,transport:'direct-browser'}},location.origin);});
 const known=()=>new Promise((resolve,reject)=>{const request=crypto.randomUUID(),timer=setTimeout(()=>{pending.delete(request);reject(Error('Нет ответа от локальной БД'));},10000);pending.set(request,{resolve:v=>{clearTimeout(timer);resolve(new Map((v.sources||[]).map(s=>[s.id,s])));},reject:e=>{clearTimeout(timer);reject(e);}});window.postMessage({channel:CHANNEL,type:'known',provider,request},location.origin);});
 const changed=(previous,id,updated)=>{const old=previous.get(id);return !old||old.partial||!updated||Date.parse(old.updated)!==Date.parse(updated);};
 window.fetch=async(input,init)=>{
  try{const url=new URL(typeof input==='string'?input:input.url,location.origin);if(provider==='chatgpt'&&url.origin===location.origin&&url.pathname.startsWith('/backend-api/')){const h=new Headers(init?.headers||(typeof input==='object'?input.headers:undefined)),v=h.get('Authorization');if(v?.startsWith('Bearer '))token=v.slice(7);}}catch{}
  return fetchOriginal(input,init);
 };
 async function request(url){
  if(Date.now()<cooldown)throw Error('Сервис ограничил запросы. Повторите после '+new Date(cooldown).toLocaleTimeString());
  const r=await fetchOriginal(url,{credentials:'same-origin',headers:provider==='chatgpt'&&token?{Authorization:'Bearer '+token}:{}});
  if(r.status===429){cooldown=Date.now()+Math.max(900,Number(r.headers.get('retry-after'))||0)*1000;throw Error('Лимит запросов сервиса. Сбор приостановлен минимум на 15 минут.');}
  if(!r.ok)throw Error('Источник ответил '+r.status+'. Откройте разговор в своей обычной сессии и повторите.');
  if(!(r.headers.get('content-type')||'').includes('json'))throw Error('Источник вернул страницу вместо данных. Автоматический обход проверки не выполняется.');
  return r.json();
 }
 async function gptToken(){if(token)return;const s=await request('/api/auth/session');if(!s.accessToken)throw Error('Откройте ChatGPT в своём аккаунте, затем попробуйте ещё раз.');token=s.accessToken;}
 async function gptChat(id){
  const main=await request('/backend-api/conversations/'+encodeURIComponent(id)+'?num_turns=10&include_has_versions=true');
  if(main.mapping){await deliver(main);return;}
  if(!Array.isArray(main.messages))throw Error('Изменился формат ChatGPT. Неполный разговор не записан.');
  const pages=[main],seen=new Set();let page=main;
  for(let n=0;page.page_info?.has_previous_page;n++){
   const cursor=page.page_info.start_cursor;if(!cursor||seen.has(cursor)||n>=200)throw Error('Не удалось дочитать страницы длинного чата. Текущая версия в БД сохранена.');
   seen.add(cursor);await sleep(1600);page=await request('/backend-api/conversations/'+encodeURIComponent(id)+'/messages?before='+encodeURIComponent(cursor)+'&num_turns=10&include_has_versions=true');
   if(!Array.isArray(page.messages))throw Error('Неизвестная страница ChatGPT');pages.push(page);
  }
  const messages=new Map();for(const p of pages.slice().reverse())for(const m of p.messages){const old=messages.get(m.id);if(old&&JSON.stringify(old)!==JSON.stringify(m))throw Error('Чат изменился во время чтения. Повторите сбор.');messages.set(m.id,m);}
  await deliver({...main,messages:[...messages.values()],page_info:{...main.page_info,has_previous_page:false},_secondbrain:{pages:pages.length,all_branches_verified:false}});
 }
 async function organization(){const cookie=document.cookie.split(';').map(s=>s.trim()).find(s=>s.startsWith('lastActiveOrg='))?.slice(14);if(cookie&&/^[\da-f-]{36}$/i.test(cookie))return cookie;const orgs=await request('/api/organizations');if(!Array.isArray(orgs)||orgs.length!==1||!orgs[0].uuid)throw Error('Откройте нужную организацию Claude в браузере.');return orgs[0].uuid;}
 async function run(action){
  if(busy)return report('Предыдущая загрузка ещё выполняется');busy=true;
  try{
   report('Читаем доступные разговоры…');let count=0;const previous=action==='current'?new Map():await known();
   if(provider==='chatgpt'){
    await gptToken();
    if(action==='current'){const id=location.pathname.match(/\/c\/([\w-]+)/)?.[1];if(!id)throw Error('Сначала откройте разговор ChatGPT');await gptChat(id);count=1;}
    else {const list=await request('/backend-api/conversations?exclude_conversation_origin=tpp&expand=false&hide_snorlax=false&is_archived=false&is_starred=false&limit=20&order=updated&offset=0');if(!Array.isArray(list.items))throw Error('Неизвестный формат каталога ChatGPT');for(const item of list.items.filter(i=>changed(previous,i.id,i.update_time)).slice(0,3)){await sleep(1600);await gptChat(item.id);count++;}}
   }else{
    const org=await organization();
    if(action==='current'){const id=location.pathname.match(/\/chat\/([\w-]+)/)?.[1];if(!id)throw Error('Сначала откройте разговор Claude');await deliver(await request(`/api/organizations/${org}/chat_conversations/${id}?tree=True&rendering_mode=messages`));count=1;}
    else {const list=await request(`/api/organizations/${org}/chat_conversations_v2?limit=30&offset=0&archived=false&consistency=strong`);const items=Array.isArray(list)?list:list.data;if(!Array.isArray(items))throw Error('Неизвестный формат каталога Claude');for(const item of items.filter(i=>changed(previous,i.uuid,i.updated_at)).slice(0,3)){await sleep(1600);await deliver(await request(`/api/organizations/${org}/chat_conversations/${item.uuid}?tree=True&rendering_mode=messages`));count++;}}
   }
   report('Сохранено напрямую в БД: '+count+' разговоров');
  }finally{busy=false;}
 }
})();
