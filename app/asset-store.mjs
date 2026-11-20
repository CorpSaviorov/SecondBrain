import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
export async function ownAssets(store,assetRoot,{progress=()=>{}}={}){
 const root=path.resolve(assetRoot);fs.mkdirSync(root,{recursive:true});
 const report={copied:0,reused:0,already_owned:0,missing:0,bytes:0,errors:[]};
 for(const asset of store.db.prepare("SELECT * FROM assets WHERE path IS NOT NULL AND state!='missing'").all()){
  const original=path.resolve(asset.path);
  if(original.startsWith(root+path.sep)&&fs.existsSync(original)){report.already_owned++;continue;}
  if(!fs.existsSync(original)){report.missing++;continue;}
  const temporary=path.join(root,'.incoming-'+randomUUID());
  try{
   const before=fs.statSync(original),hash=createHash('sha256');
   await pipeline(fs.createReadStream(original),new Transform({transform(chunk,encoding,callback){hash.update(chunk);callback(null,chunk);}}),fs.createWriteStream(temporary,{flags:'wx'}));
   const after=fs.statSync(original);if(before.size!==after.size||before.mtimeMs!==after.mtimeMs)throw Error('Attachment changed while copying');
   const sha=hash.digest('hex'),destination=path.join(root,sha);
   if(fs.existsSync(destination)){fs.unlinkSync(temporary);report.reused++;}else{fs.renameSync(temporary,destination);report.copied++;report.bytes+=before.size;}
   const metadata={...JSON.parse(asset.metadata),original_path:asset.path,sha256:sha,storage:'canonical-assets'};
   store.db.prepare('UPDATE assets SET path=?,bytes=?,metadata=? WHERE id=?').run(destination.replaceAll('\\','/'),before.size,JSON.stringify(metadata),asset.id);
  }catch(e){if(fs.existsSync(temporary))fs.unlinkSync(temporary);report.errors.push({id:asset.id,error:e.message});}
  if((report.copied+report.reused)%50===0)progress({...report,error_count:report.errors.length,errors:undefined});
 }
 return report;
}
