// Source dates and reviewed usefulness. Never use file mtime or ai_updated as age.
import {createUnitScanner} from './stream.mjs';
export const REASON_CODES=new Set(['decision','result','specific_goal','clear_constraints','reusable_explanation','actionable_steps','source_traceability','generic_question','context_missing','duplicate_or_boilerplate']);
export function dateMillis(value){
 if(typeof value!=='string'||value.length>80)return null;
 const m=value.trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:\d{2})?)?$/);
 if(!m)return null;
 const [y,mo,d,h,mi,s]=[m[1],m[2],m[3],m[4]||0,m[5]||0,m[6]||0].map(Number);
 if(y<1900||mo<1||mo>12||d<1||d>31||h>23||mi>59||s>59)return null;
 const day=new Date(Date.UTC(y,mo-1,d));if(day.getUTCMonth()!==mo-1||day.getUTCDate()!==d)return null;
 let offset=180; // Zone-less source dates are Europe/Moscow, not the host timezone.
 if(m[8]==='Z')offset=0;
 else if(m[8]){const oh=Number(m[8].slice(1,3)),om=Number(m[8].slice(4));if(oh>14||om>59||(oh===14&&om))return null;offset=(m[8][0]==='-'?-1:1)*(oh*60+om);}
 return Date.UTC(y,mo-1,d,h,mi,s,Number((m[7]||'').padEnd(3,'0').slice(0,3)))-offset*60000;
}
export function newest(candidates){
 const byBasis=new Map();
 for(const entry of candidates){const ms=dateMillis(entry.value);if(ms!==null&&(!byBasis.has(entry.basis)||ms>byBasis.get(entry.basis).ms))byBasis.set(entry.basis,{ms,value:new Date(ms).toISOString(),basis:entry.basis});}
 return [...byBasis.values()].map(({ms,...entry})=>entry);
}
export function sourceDates({source,filename,body='',values={},units}){
 const candidates=[],add=(value,basis)=>{if(dateMillis(value)!==null)candidates.push({value,basis});};
 const raw=['chatgpt','codex','claude-code'].includes(source);
 if(raw){
  add(values.updated,'source-updated');add(values.source_date,'declared-source-date');
  if(!units){const scanner=createUnitScanner({raw:true});scanner.push({text:body,start:0});units=scanner.finish(body.length);}
  for(const unit of units)if(unit.time)add(unit.time,'message');
 }else if(source==='wiki'){
  add(values.source_date,'declared-source-date');add(values.date,'declared-date');
  let fence=null;
  for(const line of body.split(/\r?\n/)){
   const marker=line.match(/^\s*(`{3,}|~{3,})/);if(marker){if(!fence)fence=marker[1][0];else if(fence===marker[1][0])fence=null;continue;}
   if(!fence){const m=line.match(/^- \*\*(\d{4}-\d{2}-\d{2}) · /);if(m)add(m[1],'dated-wiki-entry');}
  }
  if(!candidates.length)add(values.created,'note-created');
 }else{
  add(values.source_date,'declared-source-date');add(values.date,'declared-date');
  if(!candidates.length){add(values.updated,'note-updated');add(values.created,'note-created');}
 }
 if(!candidates.length){const m=filename.match(/^(\d{4}-\d{2}-\d{2})(?:\D|$)/);if(m)add(m[1],'filename');}
 return newest(candidates);
}
export function resolvedDate(doc,now){
 const valid=(doc.source_dates||[]).map(d=>({...d,ms:dateMillis(d.value)})).filter(d=>d.ms!==null&&d.ms<=now+300000);
 return valid.sort((a,b)=>b.ms-a.ms)[0]||null;
}
export function rankingOptions({ranking='balanced',since}={}){
 if(!['balanced','recent','relevance'].includes(ranking))throw Error('Invalid ranking mode');
 if(since!==undefined&&(!/^\d{4}-\d{2}-\d{2}$/.test(since)||dateMillis(since)===null))throw Error('since must be a valid YYYY-MM-DD date');
 return {ranking,since,sinceMs:since===undefined?null:dateMillis(since)};
}
export function rankedScore(lexical,doc,assessment,now,mode='balanced'){
 const date=resolvedDate(doc,now),age=date?Math.max(0,(now-date.ms)/86400000):null;
 const freshness=age===null?1:1+0.20*Math.pow(0.5,age/90);
 const usefulness=assessment?1+(assessment.score-2.5)*0.06:1;
 return {score:mode==='relevance'?lexical:lexical*freshness*usefulness,
  source_date:date?.value??null,source_date_basis:date?.basis??null,
  usefulness_score:assessment?.score??null,lexical_score:lexical,
  freshness_factor:mode==='relevance'?1:freshness,usefulness_factor:mode==='relevance'?1:usefulness};
}
export function validateAssessment(record,note){
 if(record.reviewer!=='gpt-6-luna'||record.coverage!=='full-saved-markdown'||record.reviewed_chars!==note.text.length||note.text.length>20000||record.path!==note.path||record.sha256!==note.sha256)throw Error('A complete, unchanged saved source reviewed by Luna is required');
 if(!Number.isFinite(record.score)||record.score<0||record.score>5)throw Error('Usefulness score must be between 0 and 5');
 if(!Array.isArray(record.reason_codes)||record.reason_codes.length>5||record.reason_codes.some(code=>!REASON_CODES.has(code)))throw Error('Invalid usefulness reason codes');
 return {...record,reason_codes:[...new Set(record.reason_codes)].sort()};
}
