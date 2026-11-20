const {app,BrowserWindow}=require('electron');const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../../store/cloud-browser'),core='http://127.0.0.1:'+(process.env.BRAIN_PORT||8877),helperPort=Number(process.env.BRAIN_CLOUD_PORT||8878);fs.mkdirSync(root,{recursive:true});app.setPath('userData',root);
if(!app.requestSingleInstanceLock())app.quit();
const windows=new Map(),state={chatgpt:{status:'needs-login'},claude:{status:'needs-login'}},jobs=new Map();
const origin=p=>p==='chatgpt'?'https://chatgpt.com':'https://claude.ai';
const allowed=(p,route)=>p==='chatgpt'?/^\/backend-api\/(?:conversations(?:\/[a-f\d-]{36}(?:\/messages)?)?|gizmos\/snorlax\/sidebar|gizmos\/g-p-[a-f\d]{32}\/conversations)(?:\?|$)/i.test(route):/^\/api\/(?:organizations(?:\/[a-f\d-]{36}(?:\/chat_conversations_v2|\/chat_conversations\/[a-f\d-]{36})?)?)(?:\?|$)/i.test(route);
function windowFor(provider,visible=false){let w=windows.get(provider);if(w&&!w.isDestroyed()){if(visible){if(w.isMinimized())w.restore();w.show();w.focus();}return w;}
 w=new BrowserWindow({title:'SecondBrain — вход '+(provider==='chatgpt'?'ChatGPT':'Claude'),width:1100,height:820,show:visible,webPreferences:{partition:'persist:'+provider,contextIsolation:true,nodeIntegration:false,sandbox:true}});windows.set(provider,w);if(visible){w.show();w.focus();w.once('ready-to-show',()=>{w.show();w.focus();});}
 w.on('page-title-updated',e=>{e.preventDefault();w.setTitle('SecondBrain — '+(provider==='chatgpt'?'ChatGPT':'Claude'));});
 w.webContents.setWindowOpenHandler(({url})=>{try{const u=new URL(url);if(u.protocol==='https:'&&['openai.com','chatgpt.com','claude.ai','anthropic.com','google.com','apple.com','microsoftonline.com','auth0.com'].some(d=>u.hostname===d||u.hostname.endsWith('.'+d)))return {action:'allow'};}catch{}return {action:'deny'};});
 w.on('closed',()=>windows.delete(provider));w.loadURL(origin(provider)).catch(()=>state[provider]={status:'needs-login',message:'Откройте вход повторно'});return w;
}
async function ready(w){if(!w.webContents.isLoading())return;await new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(Error('Окно входа ещё загружается')),45000);w.webContents.once('did-finish-load',()=>{clearTimeout(t);resolve();});});}
async function pageGet(provider,route){
 if(!allowed(provider,route))throw Error('Этот адрес сбора не разрешён');const w=windowFor(provider);await ready(w);if(!w.webContents.getURL().startsWith(origin(provider)+'/')){const e=Error('Завершите вход в аккаунт');e.status=401;throw e;}
 const result=await w.webContents.executeJavaScript(`(async()=>{try{const route=${JSON.stringify(route)},headers={Accept:'application/json'};if(${JSON.stringify(provider)}==='chatgpt'){const s=await fetch('/api/auth/session',{credentials:'include'});if(!s.ok)return {status:s.status};const value=await s.json();if(!value.accessToken)return {status:401};headers.Authorization='Bearer '+value.accessToken;}const r=await fetch(route,{credentials:'include',headers,signal:AbortSignal.timeout(40000)});if(!r.ok)return {status:r.status};if(!(r.headers.get('content-type')||'').includes('application/json'))return {status:403};return {status:200,data:await r.json()};}catch{return {status:0}}})()`,true);
 if(result.status!==200){const e=Error(result.status===401?'Нужно войти в аккаунт':result.status===403?'Сервис просит проверку входа. Откройте окно подключения':result.status===429?'Сервис ограничил частоту. Сбор остановлен без повторов':'Ошибка чтения аккаунта ('+result.status+')');e.status=result.status;throw e;}return result.data;
}
async function local(route,body){const r=await fetch(core+route,{...(body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(60000)}),v=await r.json();if(!r.ok)throw Error(v.error||'Локальная БД недоступна');return v;}
async function probe(provider){try{if(jobs.has(provider))return state[provider];const route=provider==='chatgpt'?'/backend-api/conversations?offset=0&limit=1':'/api/organizations';await pageGet(provider,route);state[provider]={...state[provider],status:'authenticated',message:'Вход подтверждён. Можно собрать переписки'};const w=windows.get(provider);if(w&&!w.isDestroyed())w.hide();}catch(e){state[provider]={...state[provider],status:e.status===401||e.status===403?'needs-login':'error',message:e.message};}return state[provider];}
async function collect(provider,connectorId){
 if(jobs.has(provider))return jobs.get(provider);const operation=(async()=>{
  const connectors=await local('/api/connectors'),connector=connectors.connectors.find(c=>c.id===connectorId&&c.provider===provider);if(!connector?.enabled)throw Error('Подключение отключено');
  state[provider]={status:'collecting',started_at:new Date().toISOString()};const checkpointFile=path.join(root,provider+'-checkpoint.json');let checkpoint={};if(fs.existsSync(checkpointFile))checkpoint=JSON.parse(fs.readFileSync(checkpointFile,'utf8'));
  const save=cp=>{const temp=checkpointFile+'.tmp';fs.writeFileSync(temp,JSON.stringify(cp));fs.renameSync(temp,checkpointFile);};
  const {syncAccount}=await import('./sync.mjs'),known=await local('/api/known?'+new URLSearchParams({provider,connector_id:connectorId}));
  const result=await syncAccount({provider,get:p=>pageGet(provider,p),known:known.sources,checkpoint,save,ingest:data=>local('/api/ingest',{provider,connector_id:connectorId,account:connector.config.account||'personal',data,transport:'direct-independent-cloud'}),isEnabled:async()=>{try{const s=await local('/api/connectors');return Boolean(s.connectors.find(c=>c.id===connectorId)?.enabled);}catch{return false;}},pause:()=>new Promise(r=>setTimeout(r,1400))});
  const {checkpoint:omit,...summary}=result;state[provider]={status:'ready',finished_at:new Date().toISOString(),...summary};return state[provider];
 })().catch(e=>{state[provider]={status:e.status===401||e.status===403?'needs-login':'error',message:e.message};return state[provider];}).finally(()=>jobs.delete(provider));jobs.set(provider,operation);return operation;
}
app.on('window-all-closed',()=>{});
app.whenReady().then(()=>{
 const server=http.createServer(async(req,res)=>{const send=(code,value)=>{res.writeHead(code,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value));};try{const u=new URL(req.url,'http://127.0.0.1'),provider=u.searchParams.get('provider');if(u.pathname==='/status')return send(200,{app:'secondbrain-cloud-v1',providers:state});if(req.method==='POST'&&u.pathname==='/shutdown'){if(jobs.size)return send(409,{error:'Сбор ещё выполняется'});for(const w of windows.values())if(!w.isDestroyed())await w.webContents.session.cookies.flushStore();send(200,{stopped:true});setTimeout(()=>app.quit(),100);return;}if(!['chatgpt','claude'].includes(provider))return send(400,{error:'Неизвестный источник'});
  if(req.method==='POST'&&u.pathname==='/login'){windowFor(provider,true);return send(200,{opened:true,provider});}
  if(req.method==='POST'&&u.pathname==='/probe')return send(200,await probe(provider));
  if(req.method==='POST'&&u.pathname==='/collect')return send(200,await collect(provider,u.searchParams.get('connector_id')||provider));return send(404,{error:'Неизвестное действие'});
 }catch(e){send(400,{error:e.message});}});server.on('error',()=>app.quit());server.listen(helperPort,'127.0.0.1');
});
