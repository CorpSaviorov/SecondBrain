import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import fs from 'node:fs';
export async function collect(store,connector,{signal,isEnabled}){
 if(!connector.config.roots?.some(r=>fs.existsSync(r)))throw Error('Папки локального источника недоступны');
 const key='files:'+connector.id,previous=store.db.prepare('SELECT payload FROM connector_state WHERE id=?').get(key);
 const packet=await new Promise((resolve,reject)=>{
  const child=spawn((process.env.BRAIN_PYTHON||(process.platform==='win32'?'python':'python3')),[fileURLToPath(new URL('../native-read.py',import.meta.url))],{windowsHide:true,signal,env:{...process.env,PYTHONIOENCODING:'utf-8'}});
  let output='',errors='',size=0;const timer=setTimeout(()=>{child.kill();reject(Error('Local source read exceeded 90 seconds'));},90000);
  child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
  child.stdout.on('data',chunk=>{size+=Buffer.byteLength(chunk);if(size>128*1024*1024){child.kill();reject(Error('Local source response exceeds 128 MB'));}else output+=chunk;});
  child.stderr.on('data',chunk=>errors+=chunk.toString('utf8'));child.on('error',e=>{clearTimeout(timer);reject(e);});child.on('exit',code=>{clearTimeout(timer);if(code!==0)return reject(Error('Native adapter failed: '+errors.slice(-250)));try{resolve(JSON.parse(output));}catch{reject(Error('Native adapter returned invalid JSON'));}});
  child.stdin.end(JSON.stringify({provider:connector.provider,config:connector.config,checkpoint:previous?JSON.parse(previous.payload):{}}));
 });
 const result={changed:0,sources:0,deferred:packet.deferred,skipped_nonconversations:packet.skipped_nonconversations||0,errors:packet.errors};
 for(const source of packet.sources){if(!isEnabled())break;const r=store.ingest(source,{transport:'direct-local-session'});result.sources++;if(r.changed)result.changed++;}
 if(isEnabled())store.state(key,'ready',packet.checkpoint);return result;
}
