// Bounded UTF-8 source scan. Full-version hash, bounded decoded buffers/ranges.
import {openSync,closeSync,readSync,fstatSync,lstatSync,constants} from 'node:fs';
import {createHash} from 'node:crypto';
export const MAX_SOURCE_BYTES=64_000_000,CHUNK_CHARS=32768;
export const sameVersion=(a,b)=>['dev','ino','size','mtimeMs','ctimeMs','nlink'].every(k=>a[k]===b[k]);
const high=n=>n>=0xd800&&n<=0xdbff,low=n=>n>=0xdc00&&n<=0xdfff;
export const newlines=text=>{let n=0;for(let i=0;i<text.length;i++)if(text.charCodeAt(i)===10)n++;return n;};
export async function scanSource({guard,relative,maxBytes=MAX_SOURCE_BYTES,onChunk=()=>{},ranges=[]}){
 if(ranges.length>3||ranges.some(r=>!Number.isSafeInteger(r.start)||!Number.isSafeInteger(r.end)||r.start<0||r.end<r.start||r.end-r.start>16000))throw Error('Invalid bounded source ranges');
 let fd;try{fd=openSync(guard(relative),constants.O_RDONLY|(constants.O_NOFOLLOW||0));}catch(e){throw Error(e.code==='ENOENT'?'Note not found':'Cannot open note');}
 try{
  const before=fstatSync(fd);if(!before.isFile()||before.nlink>1)throw Error('Links are forbidden');
  if(before.size>maxBytes)throw Error('Source exceeds streaming limit');
  const hash=createHash('sha256'),decoder=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}),buffer=Buffer.allocUnsafe(65536);
  const captured=ranges.map(r=>({...r,text:'',base:null,base_line:null}));
  let pending='',offset=0,line=1,bytes=0,chunks=0;
  const emit=text=>{
   const end=offset+text.length;
   for(const range of captured){
    if(range.end<=offset||range.start>=end)continue;
    let from=Math.max(0,range.start-offset),to=Math.min(text.length,range.end-offset);
    if(from>0&&low(text.charCodeAt(from))&&high(text.charCodeAt(from-1)))from--;
    if(to>from&&high(text.charCodeAt(to-1))&&low(text.charCodeAt(to)))to--;
    if(range.base===null){range.base=offset+from;range.base_line=line+newlines(text.slice(0,from));}
    range.text+=text.slice(from,to);
   }
   onChunk({text,start:offset,end,start_line:line});
   line+=newlines(text);offset=end;chunks++;
  };
  for(;;){
   const count=readSync(fd,buffer,0,buffer.length,null);if(!count)break;
   bytes+=count;if(bytes>maxBytes)throw Error('Source exceeds streaming limit');
   hash.update(buffer.subarray(0,count));pending+=decoder.decode(buffer.subarray(0,count),{stream:true});
   while(pending.length>=CHUNK_CHARS){let end=CHUNK_CHARS;if(high(pending.charCodeAt(end-1))&&low(pending.charCodeAt(end)))end--;emit(pending.slice(0,end));pending=pending.slice(end);}
   if(chunks&&chunks%16===0)await new Promise(resolve=>setImmediate(resolve));
  }
  pending+=decoder.decode();if(pending.length)emit(pending);
  const after=fstatSync(fd),current=lstatSync(guard(relative));
  if(!sameVersion(before,after)||!sameVersion(after,current)||!current.isFile()||current.isSymbolicLink()||after.nlink>1||bytes!==after.size)throw Error('Note changed while reading; retry');
  for(const range of captured){if(range.start>offset)throw Error('Fragment offset exceeds source length');if(range.base===null){range.base=offset;range.base_line=line;}}
  return {path:relative,sha256:hash.digest('hex'),total_chars:offset,total_bytes:bytes,ranges:captured,chunks};
 }finally{closeSync(fd);}
}

// Structural state only: line prefixes are capped even for huge unbroken lines.
export function createUnitScanner({raw,bodyStart=0,maxUnits=50000}){
 const units=[];let prefix='',lineStart=0,lineNo=1,fence=null,pendingDate=null;
 function line(text,end){
  if(pendingDate){
   const available=Math.max(0,200-(lineStart-pendingDate.after));
   const candidate=text.slice(0,available),date=candidate.match(/^\s*Дата: ([^\r\n]+)/);
   if(date)pendingDate.unit.time=date[1].slice(0,80);
   if(date||candidate.trim()||!available)pendingDate=null;
  }
  if(lineStart>=bodyStart){
   const marker=text.match(/^\s*(`{3,}|~{3,})/);
   if(marker){if(!fence)fence=marker[1][0];else if(marker[1][0]===fence)fence=null;}
   else if(!fence){
    const message=raw?text.match(/^## (You|ChatGPT|user|assistant|Human|Claude|Gemini|Codex) · ([^\r\n]+)/):null;
    const heading=!raw?text.match(/^#{1,6} ([^\r\n]+)/):null;
    let unit;
    if(message){
     const label=message[1],meta=message[2],id=/^(?:[a-f\d-]{36}|msg_[\w-]{16,128})$/.test(meta)?meta:null;
     unit={start:lineStart,start_line:lineNo,role:['You','user','Human'].includes(label)?'user':'assistant',speaker:label,...(id?{message_id:id}:{time:meta.slice(0,80)})};
     if(id)pendingDate={unit,after:end};
    }else if(heading)unit={start:lineStart,start_line:lineNo,section:heading[1].slice(0,160)};
    if(unit){if(units.length>=maxUnits)throw Error('Source structure budget exceeded');units.push(unit);}
   }
  }
 }
 return {push(chunk){
  let cursor=0;
  for(;;){const end=chunk.text.indexOf('\n',cursor);if(end<0){prefix+=chunk.text.slice(cursor,cursor+Math.max(0,512-prefix.length));break;}
   prefix+=chunk.text.slice(cursor,Math.min(end+1,cursor+Math.max(0,512-prefix.length)));line(prefix,chunk.start+end+1);prefix='';lineStart=chunk.start+end+1;lineNo++;cursor=end+1;
  }
 },finish(total){if(prefix)line(prefix,total);if(!units.length||units[0].start>bodyStart)units.unshift({start:bodyStart,start_line:1});return units.map((u,i)=>({...u,end:units[i+1]?.start??total}));}};
}

export function createStreamRangeLoader({guard,threshold=2_100_000,maxBytes=MAX_SOURCE_BYTES}){
 return async(relative,offset,budget,expected)=>{
  const stat=lstatSync(guard(relative));if(stat.size<=threshold)return null;
  const result=await scanSource({guard,relative,maxBytes,ranges:[{start:Math.max(0,offset-1),end:offset+budget+2}]});
  if(expected&&result.sha256!==expected)throw Error('Source changed since search/read; repeat the search');
  const range=result.ranges[0];
  return {path:relative,sha256:result.sha256,large:true,text:range.text,base:range.base,base_line:range.base_line,total_chars:result.total_chars};
 };
}
