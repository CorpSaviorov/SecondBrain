// Attachment text in search (user request 2026-11-18). Text of chat/mail attachments (PDF, DOCX, XLSX, PPTX, md, txt,
// html, json…) is extracted in a separate Python process (tools/extract_text.py, pypdf) so the server never blocks,
// stored in asset_text and indexed per parent record in asset_terms. store.search reads asset_terms like card_terms.
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {words,indexTerms} from './lib/lexical.mjs';
const SCRIPT=path.join(path.dirname(fileURLToPath(import.meta.url)),'tools','extract_text.py');
const SKIP=/\.(png|jpe?g|gif|webp|bmp|heic|ogg|mp3|wav|m4a|mp4|mov|webm|zip|7z|rar|exe|dll)$/i,MAX_BYTES=60*1024*1024,BATCH=20;
export class AttachmentIndex{
 constructor(store,{python=(process.env.BRAIN_PYTHON||(process.platform==='win32'?'python':'python3')),runner=null}={}){
  this.store=store;this.python=python;this.runner=runner;this.running=null;
  store.db.exec(`CREATE TABLE IF NOT EXISTS asset_text(asset_id TEXT PRIMARY KEY,source_id TEXT,kind TEXT,chars INTEGER NOT NULL,text TEXT NOT NULL,error TEXT,extracted_at TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS asset_terms(term TEXT NOT NULL,source_id TEXT NOT NULL,asset_id TEXT NOT NULL,tf INTEGER NOT NULL,PRIMARY KEY(term,asset_id));
   CREATE INDEX IF NOT EXISTS asset_terms_source ON asset_terms(source_id);`);
 }
 pending(){return this.store.db.prepare('SELECT a.id,a.source_id,a.path,a.name,a.bytes FROM assets a LEFT JOIN asset_text t ON t.asset_id=a.id WHERE t.asset_id IS NULL AND a.path IS NOT NULL AND a.source_id IS NOT NULL').all().filter(a=>!SKIP.test(a.name||'')&&(a.bytes||0)<=MAX_BYTES&&fs.existsSync(a.path));}
 status(){const r=this.store.db.prepare("SELECT count(*) n,sum(chars>0) texts,coalesce(sum(chars),0) chars FROM asset_text").get();return {checked:r.n,with_text:r.texts||0,chars:r.chars,pending:this.pending().length,running:Boolean(this.running)};}
 // Runs the extractor on a batch; resolves to [{id,kind,text,error}].
 extract(items){if(this.runner)return this.runner(items);return new Promise((resolve,reject)=>{const child=spawn(this.python,['-I',SCRIPT],{cwd:path.dirname(SCRIPT),windowsHide:true});let out='',err='';const timer=setTimeout(()=>child.kill(),10*60*1000);
  child.stdout.setEncoding('utf8');child.stdout.on('data',d=>out+=d);child.stderr.on('data',d=>err+=d);child.on('error',e=>{clearTimeout(timer);reject(e);});
  child.on('close',code=>{clearTimeout(timer);const rows=out.split('\n').filter(Boolean).map(l=>{try{return JSON.parse(l);}catch{return null;}}).filter(Boolean);if(!rows.length&&code)reject(Error('Извлечение текста не удалось: '+err.slice(0,300)));else resolve(rows);});
  child.stdin.end(JSON.stringify(items.map(({id,path,name})=>({id,path,name}))));});}
 save(asset,row){const text=String(row?.text||''),now=new Date().toISOString(),db=this.store.db;
  this.store.transaction(()=>{db.prepare('INSERT OR REPLACE INTO asset_text VALUES(?,?,?,?,?,?,?)').run(asset.id,asset.source_id,row?.kind||null,text.length,text,row?.error||null,now);
   db.prepare('DELETE FROM asset_terms WHERE asset_id=?').run(asset.id);if(!text)return;
   const tf=new Map();for(const w of words(asset.name||''))for(const t of indexTerms(w))tf.set(t,(tf.get(t)||0)+3);for(const w of words(text))for(const t of indexTerms(w))tf.set(t,(tf.get(t)||0)+1);
   const put=db.prepare('INSERT INTO asset_terms VALUES(?,?,?,?)');for(const [t,n]of tf)put.run(t,asset.source_id,asset.id,Math.min(n,40));});}
 async run({limit=Infinity}={}){if(this.running)return this.running;this.running=(async()=>{let done=0,withText=0;try{
   const todo=this.pending().slice(0,limit);for(let i=0;i<todo.length;i+=BATCH){const batch=todo.slice(i,i+BATCH),rows=new Map((await this.extract(batch)).map(r=>[r.id,r]));for(const a of batch){const r=rows.get(a.id)||{error:'Нет ответа извлекателя'};this.save(a,r);done++;if(r.text)withText++;}}
   return {checked:done,with_text:withText};}finally{this.running=null;}})();return this.running;}
 // For agents: one bounded window of an attachment's text.
 read(assetId,{offset=0,limit=3000}={}){const r=this.store.db.prepare('SELECT t.asset_id id,t.source_id,t.kind,t.chars,t.text,a.name FROM asset_text t JOIN assets a ON a.id=t.asset_id WHERE t.asset_id=?').get(assetId);if(!r)return null;const from=Math.max(0,Number(offset)||0),size=Math.min(6000,Math.max(500,Number(limit)||3000)),body=r.text.slice(from,from+size);return {id:r.id,source_id:r.source_id,name:r.name,kind:r.kind,total_chars:r.chars,offset:from,body,next_offset:from+body.length<r.chars?from+body.length:null};}
 list(sourceId){return this.store.db.prepare('SELECT a.id,a.name,t.kind,coalesce(t.chars,0) chars FROM assets a LEFT JOIN asset_text t ON t.asset_id=a.id WHERE a.source_id=? ORDER BY a.name').all(sourceId);}
}
