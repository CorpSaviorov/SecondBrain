import os from 'node:os';
import path from 'node:path';
import {json} from '../store.mjs';
const home=os.homedir().replaceAll('\\','/');
const definitions=[
 {id:'obsidian',provider:'obsidian',name:'Obsidian',driver:'markdown-folder',enabled:true,config:{root:process.env.BRAIN_OBSIDIAN_ROOT||home+'/Documents/Obsidian Vault'}},
 {id:'codex',provider:'codex',name:'Codex',driver:'native-files',enabled:true,config:{format:'codex-jsonl',roots:[home+'/.codex/sessions',home+'/.codex/archived_sessions'],quiet_seconds:300}},
 {id:'claude-code',provider:'claude-code',name:'Claude Code',driver:'native-files',enabled:true,config:{format:'claude-code-jsonl',roots:[home+'/.claude/projects'],quiet_seconds:300}},
 {id:'chatgpt',provider:'chatgpt',name:'ChatGPT',driver:'cloud-account',enabled:true,config:{account:'personal',connection:'standalone-account-adapter-pending'}},
 {id:'claude',provider:'claude',name:'Claude',driver:'cloud-account',enabled:true,config:{account:'personal',connection:'standalone-account-adapter-pending'}},
 {id:'email-gmail',provider:'email',name:'Gmail',driver:'imap-mail',enabled:false,config:{service:'gmail'}},
 {id:'email-yandex',provider:'email',name:'Яндекс Почта',driver:'imap-mail',enabled:false,config:{service:'yandex'}},
 {id:'telegram',provider:'telegram',name:'Telegram',driver:'telegram-bot',enabled:false,config:{}}
];
export class ConnectorRegistry{
 constructor(store,{defaults=definitions}={}){
  this.store=store;this.running=new Map();this.drivers=new Map([
   ['markdown-folder',()=>import('./markdown-folder.mjs')],['native-files',()=>import('./native-files.mjs')],['cloud-account',()=>import('./cloud-account.mjs')],['imap-mail',()=>import('./imap-mail.mjs')],['telegram-bot',()=>import('./telegram-bot.mjs')]
  ]);
  store.db.exec(`CREATE TABLE IF NOT EXISTS source_connectors(id TEXT PRIMARY KEY,provider TEXT NOT NULL,name TEXT NOT NULL,
   driver TEXT NOT NULL,enabled INTEGER NOT NULL,config TEXT NOT NULL,updated_at TEXT NOT NULL);`);
  const add=store.db.prepare('INSERT OR IGNORE INTO source_connectors VALUES(?,?,?,?,?,?,?)');
  for(const c of defaults){const config={...c.config};if(['push','cloud-account'].includes(c.driver)){const account=store.db.prepare('SELECT account,count(*) n FROM sources WHERE provider=? GROUP BY account ORDER BY n DESC LIMIT 1').get(c.provider);if(account)config.account=account.account;}add.run(c.id,c.provider,c.name,c.driver,Number(c.enabled),json(config),new Date().toISOString());}
  const migratingCloud=store.db.prepare("SELECT id FROM source_connectors WHERE id IN ('chatgpt','claude') AND driver='push'").all();
  store.db.prepare("UPDATE source_connectors SET driver='cloud-account' WHERE id IN ('chatgpt','claude') AND driver='push'").run();
  for(const c of migratingCloud)store.state(c.id,'needs-login',{message:'Нужен вход в независимое подключение',driver:'cloud-account'});
  store.db.prepare("INSERT OR IGNORE INTO connector_state SELECT 'files:obsidian',status,updated_at,payload FROM connector_state WHERE id='note-files'").run();
 }
 get(id){const r=this.store.db.prepare('SELECT * FROM source_connectors WHERE id=?').get(id);return r?{...r,enabled:Boolean(r.enabled),config:JSON.parse(r.config)}:null;}
 list(){return this.store.db.prepare('SELECT id FROM source_connectors ORDER BY id').all().map(({id})=>{
  const c=this.get(id),state=this.store.db.prepare('SELECT status,updated_at,payload FROM connector_state WHERE id=?').get(id);
  let status=!c.enabled?'disabled':this.running.has(id)?'syncing':state?.status||(['cloud-account','imap-mail'].includes(c.driver)?'needs-login':'not-connected'),payload=state?JSON.parse(state.payload):{};
  if(c.id==='email'&&c.driver==='push'&&c.config.connection==='mail-adapter-pending')return null;
  if(c.driver==='push'&&(!payload.live_capture||payload.host?.includes('Obsidian')||payload.mode==='saved-account-direct'))status=c.enabled?'awaiting-adapter':'disabled';
  if(c.driver==='push'&&status==='awaiting-adapter')payload={...payload,message:undefined};
  return {...c,status,payload,collectable:this.drivers.has(c.driver),running:this.running.has(id),state_updated_at:state?.updated_at||null};
 }).filter(Boolean);}
 configure(id,changes){
  const c=this.get(id);if(!c)throw Error('Unknown source connector');
  if(changes.config!==undefined&&(!changes.config||Array.isArray(changes.config)||typeof changes.config!=='object'))throw Error('Invalid connector configuration');
  const enabled=changes.enabled===undefined?c.enabled:changes.enabled;if(typeof enabled!=='boolean')throw Error('enabled must be true or false');
  this.store.db.prepare('UPDATE source_connectors SET enabled=?,config=?,updated_at=? WHERE id=?').run(Number(enabled),json(changes.config===undefined?c.config:{...c.config,...changes.config}),new Date().toISOString(),id);
  if(!enabled)this.running.get(id)?.abort();
  return this.list().find(c=>c.id===id);
 }
 register({id,provider,name,driver='push',enabled=false,config={}}){
  if(!/^[a-z][a-z0-9_-]{0,50}$/.test(id)||!/^[a-z][a-z0-9_-]{0,40}$/.test(provider)||!name||!['push',...this.drivers.keys()].includes(driver))throw Error('Invalid connector definition');
  this.store.db.prepare('INSERT INTO source_connectors VALUES(?,?,?,?,?,?,?)').run(id,provider,name,driver,Number(enabled),json(config),new Date().toISOString());return this.get(id);
 }
 accepts(provider,{account,id}={}){return this.list().some(c=>c.enabled&&c.provider===provider&&(!id||c.id===id)&&(!account||!c.config.account||c.config.account===account));}
 defaultAccount(provider,id){return (id?this.get(id):this.get(provider))?.config.account||'personal';}
 async collect(id){
  const c=this.get(id);if(!c)throw Error('Unknown source connector');
  if(!c.enabled)return {id,skipped:'disabled'};
  if(!this.drivers.has(c.driver))return {id,skipped:'awaiting-standalone-adapter'};
  if(this.running.has(id))return {id,busy:true};
  const controller=new AbortController();this.running.set(id,controller);
  try{
   const driver=await this.drivers.get(c.driver)();
   const result=await driver.collect(this.store,c,{signal:controller.signal,isEnabled:()=>this.get(id)?.enabled&&!controller.signal.aborted});
   if(this.get(id)?.enabled)this.store.state(id,result.errors?.length||result.deferred?'partial':['cloud-account','imap-mail'].includes(c.driver)&&(result.remaining||result.partial||!result.catalog_scan_complete)?'backfill':'ready',{...result,direct_to_db:true,live_capture:true,driver:c.driver});
   return {id,...result};
  }catch(e){
   if(controller.signal.aborted)return {id,skipped:'disabled'};
   this.store.state(id,e.needsLogin?'needs-login':'error',{message:e.message,driver:c.driver});return {id,error:e.message};
  }finally{this.running.delete(id);}
 }
 async collectAll(){const results=[];for(const c of this.list())results.push(await this.collect(c.id));return {results,changed:results.reduce((n,r)=>n+(r.changed||0),0)};}
}
