import {hash} from './store.mjs';
import {mask} from './lib/secrets.mjs';
const roles={user_goal:'user',user_request:'user',user_reported_action:'user',accepted_decision:'user',assistant_suggestion:'assistant',assistant_reported_action:'assistant',note_statement:'note',note_question:'note',source_statement:'email',source_question:'email'};
const str=(v,n,name)=>{if(typeof v!=='string'||!v.trim()||v.length>n)throw Error('Некорректное поле: '+name);return v.trim();};
const list=(v,n,m,name)=>{if(!Array.isArray(v)||v.length>n)throw Error('Некорректный список: '+name);return [...new Set(v.map(s=>str(s,m,name)))];};
export function freezeSource(source,version){
 const messages=JSON.parse(version.messages),kind=source.kind==='email'?'email':source.kind==='note'?'note':messages.some(m=>['user','assistant'].includes(m.role))?'chat':'note';
 // Token economy (2026-11-18): chats send Luna only user/assistant turns (cards may cite nothing else; tool output,
 // search results and system text stay in the database and search) with a compact header; ids map back locally.
 let text='',units=[];const kept=kind==='chat'?messages.filter(m=>['user','assistant'].includes(m.role)&&String(m.text||'').trim()):messages;
 for(const [i,m]of kept.entries()){
  const header=`[u${i} ${m.role}${m.time?' · '+String(m.time).slice(0,10):''}]\n`;text+=header;const start=text.length;text+=mask(m.text||'');
  units.push({id:'u'+i,message_id:m.id,role:m.role,start,end:text.length,...(m.time?{time:m.time}:{})});text+='\n\n';
 }
 if(!messages.length){text=mask(version.body||'');if(kind==='note')units=[{id:'u0',message_id:'note',role:'note',start:0,end:text.length}];}
 const snapshot={format:'canonical-transcript-v2',source_id:source.id,revision:source.revision,source_kind:kind,path:source.source_path||'db:'+source.id,sha256:hash(text),text,units,total_chars:text.length};
 const ranges=[];let start=0;
 while(start<text.length){let end=Math.min(text.length,start+9000);const boundary=units.filter(u=>u.end>start&&u.end<=end).at(-1)?.end;if(boundary&&boundary-start>1000)end=boundary;if(text.length-end<=2)end=text.length;
  for(;;){if(end<text.length&&/^[\uDC00-\uDFFF]$/.test(text[end]))end--;const p=windowPacket(snapshot,{start_char:start,end_char:end},ranges.length,0);if(JSON.stringify(p).length<15500)break;end=start+Math.floor((end-start)*.75);if(end<=start)throw Error('Не удалось ограничить пакет');}
  ranges.push({start_char:start,end_char:end});start=end;
 }
 if(!ranges.length)ranges.push({start_char:0,end_char:0});
 const whole=windowPacket(snapshot,{start_char:0,end_char:text.length},0,1);
 if(text.length<=12000&&JSON.stringify(whole).length<15500)ranges.splice(0,ranges.length,{start_char:0,end_char:text.length});
 return {...snapshot,ranges,plan_sha256:hash({revision:source.revision,sha256:snapshot.sha256,ranges}),full:ranges.length===1};
}
function windowPacket(s,range,index,total){return {schema:'canonical-review-packet-v1',source_id:s.source_id,revision:s.revision,source_kind:s.source_kind,path:s.path,sha256:s.sha256,total_chars:s.total_chars,part_index:index,total_parts:total,start_char:range.start_char,end_char:range.end_char,text:s.text.slice(range.start_char,range.end_char),units:s.units.filter(u=>u.start<range.end_char&&u.end>range.start_char).map(u=>({...u,clipped_start:Math.max(u.start,range.start_char),clipped_end:Math.min(u.end,range.end_char)}))};}
export function reviewPacket(s,index){const p=windowPacket(s,s.ranges[index],index,s.ranges.length);p.plan_sha256=s.plan_sha256;p.allowed_item_kinds=Object.fromEntries(Object.entries(roles).filter(([kind,role])=>s.source_kind==='chat'?['user','assistant'].includes(role):s.source_kind==='note'?role==='note':role==='email'));p.output_contract={disposition:'card | no-useful-content | needs-manual-review',title:'Краткий заголовок',questions:['до 5 вопросов'],keywords:['до 20 терминов'],items:[{kind:s.source_kind==='note'?'note_statement':s.source_kind==='email'?'source_statement':'user_goal',text:'до 400 символов; сохраняй атрибуцию',evidence:[{unit_id:'идентификатор из units',role:'точная роль',quote:'буквальная уникальная цитата 6–500 символов'}]}],uncertainties:['до 5 неопределённостей']};return p;}
function meta(v){return {title:str(v.title,200,'title'),questions:list(v.questions,5,200,'questions'),keywords:list(v.keywords,20,60,'keywords'),uncertainties:list(v.uncertainties||[],5,240,'uncertainties')};}
// Find a quote exactly once in a window. Exact match first; otherwise a deterministic locator that ignores
// inline Markdown markers (`, *, _, ~), backslash escapes and whitespace runs. The stored quote is always the
// verbatim source span, never the model's wording; ambiguous or absent matches are rejected.
export function locateQuote(window,quote){
 const at=window.indexOf(quote);if(at>=0)return window.indexOf(quote,at+1)===-1?{start:at,end:at+quote.length,normalized:false}:null;
 // Normalised comparison; the STORED span is always the verbatim source text. Tolerated: inline Markdown markers,
 // escaped punctuation and whitespace runs; JSON escapes of tool output (backslash-u XXXX); line breaks the model wrote
 // as literal backslash-n/r/t; '>' and '#' at a line start; transcript marks "-- [00:13:34, speaker_2]" between segments
 // of the SAME speaker. A mark that changes the speaker stays a hard break, so a quote can never merge two speakers.
 const MARK=/--\s?\[\d{1,2}:\d{2}(?::\d{2})?,\s*(speaker_\d+)\]/y,BREAK=String.fromCharCode(0);
 const TMARK=/(?:`{3}[ \t]*\r?\n\s*#{1,6}[ \t]*Страница[ \t]+\d+[ \t]*\r?\n\s*`{3}[\w-]*[ \t]*\r?\n)?\d{1,2}:\d{2}(?::\d{2})?[ \t]*\r?\n[ \t]*(s\d+|speaker_?\d+|Спикер[ \t]?\d+|[A-Za-zА-Яа-яЁё][A-Za-zА-Яа-яЁё0-9 ._-]{0,38}?)[ \t]*:[ \t]?/y;
 // 2026-11-20: transcripts with real names ("00:18:27⏎Анна: ..."). Inside such a transcript a line-start
 // "Имя: " label (Luna sometimes keeps it in a quote and drops the time) follows the same-speaker rule.
 const LABEL=/([A-Za-zА-Яа-яЁё][A-Za-zА-Яа-яЁё0-9 ._-]{0,38}?)[ \t]*:[ \t]+/y;
 const transcript=/(?:^|\n)[ \t]*\d{1,2}:\d{2}(?::\d{2})?[ \t]*\r?\n[ \t]*[^\r\n:]{1,40}:/.test(window);
 const norm=src=>{let out='',st=[],en=[],space=false,line=true,speaker=null;
  const emit=(ch,from,to)=>{if(ch===' '){if(space||!out.length)return;space=true;}else space=false;out+=ch;st.push(from);en.push(to);};
  for(let i=0;i<src.length;i++){const from=i,ch=src[i];
   MARK.lastIndex=i;const m=ch==='-'?MARK.exec(src):null;
   if(m){const same=speaker===null||speaker===m[1];speaker=m[1];i=MARK.lastIndex-1;if(same)emit(' ',from,i+1);else emit(BREAK,from,i+1);continue;}
   if(ch==='\\'&&src[i+1]==='u'&&/^[0-9a-fA-F]{4}$/.test(src.slice(i+2,i+6))){i+=5;emit(String.fromCharCode(parseInt(src.slice(from+2,from+6),16)),from,i+1);line=false;continue;}
   if(ch==='\\'&&'nrt'.includes(src[i+1]||'')){i++;emit(' ',from,i+1);line=src[i]==='n';continue;}
   if(ch==='\\'&&i+1<src.length&&/[!-\/:-@\[-`{-~]/.test(src[i+1])){i++;emit(src[i],i,i+1);line=false;continue;}
   // Line-start transcript marks "00:43:50⏎s0: " (optionally after a "``` ## Страница N ```text" page break), 2026-11-19:
   // same rule as above — skipped only between segments of the same speaker.
   if(line&&(ch==='`'||(ch>='0'&&ch<='9'))){TMARK.lastIndex=i;const t=TMARK.exec(src);if(t){const sp=t[1].toLowerCase().replace(/\s+/g,'');const same=speaker===null||speaker===sp;speaker=sp;i=TMARK.lastIndex-1;if(same)emit(' ',from,i+1);else emit(BREAK,from,i+1);line=false;continue;}}
   if(transcript&&line&&/[A-Za-zА-Яа-яЁё]/.test(ch)){LABEL.lastIndex=i;const t=LABEL.exec(src);if(t){const sp=t[1].toLowerCase().replace(/\s+/g,'');const same=speaker===null||speaker===sp;speaker=sp;i=LABEL.lastIndex-1;if(same)emit(' ',from,i+1);else emit(BREAK,from,i+1);line=false;continue;}}
   if('`*_~'.includes(ch))continue;
   if(line&&(ch==='>'||ch==='#'))continue;
   if(/\s/.test(ch)){if(ch==='\n')line=true;emit(' ',from,i+1);continue;}
   line=false;emit(ch,from,i+1);}
  while(out.endsWith(' ')){out=out.slice(0,-1);st.pop();en.pop();}return {out,st,en};};
 const w=norm(window),q=norm(quote).out;if(q.length<6)return null;const i=w.out.indexOf(q);if(i<0||w.out.indexOf(q,i+1)!==-1)return null;
 return {start:w.st[i],end:w.en[i+q.length-1],normalized:true};
}
export function validateReview(v,s,index,{previousFailures=0}={}){
 // A review with no items is an empty review whatever disposition Luna chose: generated questions/keywords without
 // verified items are dropped (never indexed), and an empty title gets a neutral placeholder.
 if(v&&Array.isArray(v.items)&&!v.items.length&&['card','no-useful-content'].includes(v.disposition))v={...v,disposition:'no-useful-content',questions:[],keywords:[],title:typeof v.title==='string'&&v.title.trim()?v.title:'Без полезных пунктов'};
 // 2026-11-19: in a long source split into parts, «nothing here can be verified» for ONE part (e.g. a chat window that
 // refers to a call whose text is elsewhere) is an empty part, not a blocker for the whole source. Luna's reason stays
 // in uncertainties. A whole-source request for manual review, or one with items, still goes to the owner.
 if(v&&v.disposition==='needs-manual-review'&&s&&!s.full&&Array.isArray(v.items)&&!v.items.length)v={...v,disposition:'no-useful-content',questions:[],keywords:[],title:typeof v.title==='string'&&v.title.trim()?v.title:'Без проверяемых пунктов',manual_part:true};
 const p=reviewPacket(s,index),fields=meta(v);if(!['card','no-useful-content','needs-manual-review'].includes(v.disposition)||!Array.isArray(v.items)||v.items.length>8)throw Error('Неизвестный результат обработки');
 if(v.disposition==='needs-manual-review')return {manual:true,reason:'Luna запросила ручную проверку'+(fields.uncertainties.length?': '+fields.uncertainties.slice(0,2).join(' '):'')};
 if(!v.items.length){if(v.disposition!=='no-useful-content'||fields.questions.length||fields.keywords.length)throw Error('Пустой обзор не может добавлять поисковые термины');if(previousFailures&&!v.manual_part)throw Error('Пустой обзор после ошибки проверки требует ручного решения');}
 else if(v.disposition!=='card')throw Error('Пункты несовместимы с пустым обзором');
 const rejected=[];const items=v.items.flatMap((item,itemIndex)=>{try{
  const expected=roles[item.kind];if(!expected)throw Error('Неизвестный тип пункта: '+String(item.kind).slice(0,60));if((s.source_kind==='note'&&expected!=='note')||(s.source_kind==='chat'&&!['user','assistant'].includes(expected))||(s.source_kind==='email'&&expected!=='email'))throw Error('Нельзя менять автора утверждения');
  if(!Array.isArray(item.evidence)||item.evidence.length<1||item.evidence.length>4)throw Error('Нет точного источника утверждения');
  const evidence=item.evidence.map(e=>{const quote=str(e.quote,500,'quote');let u=p.units.find(u=>u.id===e.unit_id);if(quote.length<6||!u||u.role!==expected||e.role!==expected)throw Error('Цитата имеет неверную роль или сообщение');
   let hit=locateQuote(s.text.slice(u.clipped_start,u.clipped_end),quote),reattributed=null;
   // The model sometimes names a neighbouring message. Accept only when exactly one other message of the SAME role holds the quote.
   if(!hit){const alt=p.units.filter(x=>x!==u&&x.role===expected).map(x=>({x,h:locateQuote(s.text.slice(x.clipped_start,x.clipped_end),quote)})).filter(r=>r.h);if(alt.length===1){reattributed=u.id;u=alt[0].x;hit=alt[0].h;}}
   if(!hit)throw Error('Цитата не найдена дословно (или встречается больше одного раза) в проверенном окне');
   const start=u.clipped_start+hit.start,end=u.clipped_start+hit.end,exact=s.text.slice(start,end),line=n=>s.text.slice(0,n).split('\n').length;
   return {role:expected,message_id:u.message_id,...(u.time?{time:u.time}:{}),quote:exact,...(hit.normalized?{located:'markdown-insensitive',model_quote:quote}:{}),...(reattributed?{model_unit:reattributed}:{}),start_char:start,end_char:end,lines:[line(start),line(end-1)],partial_message:u.start<p.start_char||u.end>p.end_char};});
  return [{kind:item.kind,text:str(item.text,400,'item'),evidence}];
 }catch(e){rejected.push({item_index:itemIndex,reason:e.message});return [];}});
 if(v.items.length&&!items.length)throw Error(rejected[0]?.reason||'Нет подтверждённых пунктов');
 const full=s.full;return {card:{schema:full?'source-card-v1':'source-card-part-v1',reviewer:'gpt-6-luna',source_kind:s.source_kind,path:s.path,sha256:s.sha256,revision:s.revision,coverage:full?'full-saved-markdown':'source-part',...(!full?{plan_sha256:s.plan_sha256,part_index:index,total_parts:s.ranges.length,start_char:p.start_char,end_char:p.end_char}:{}),total_chars:s.total_chars,reviewed_chars:p.end_char-p.start_char,...fields,items,...(rejected.length?{validation:{status:'verified-with-omissions',rejected_items:rejected.length,errors:rejected}}:{}),summary:items.slice(0,3).map(i=>i.text).join(' '),empty_review:!items.length,evidence_format:'canonical-message-transcript-v1'}};
}
// Reuse validated part cards of a previous revision only for byte-identical leading windows:
// same prefix text up to the window end, same range, same clipped units. Every quote is re-checked
// against the new text. The first differing window stops inheritance; it and later windows are re-read.
// A synthesis is inherited only when it was built entirely from inherited parts.
export function inheritCards(s,old,oldCards,{reviewedAt}={}){
 const out=[];if(!old||s.full||old.full||s.source_id!==old.source_id||s.revision===old.revision)return out;
 const unitSig=p=>JSON.stringify(p.units.map(u=>[u.id,u.message_id,u.role,u.start,u.end,u.clipped_start,u.clipped_end,u.time||null]));
 let count=0;
 for(let i=0;i<Math.min(s.ranges.length,old.ranges.length);i++){
  const a=s.ranges[i],b=old.ranges[i],card=oldCards.get('part:'+String(i).padStart(5,'0'));
  if(!card||a.start_char!==b.start_char||a.end_char!==b.end_char)break;
  if(card.schema!=='source-card-part-v1'||card.revision!==old.revision||card.sha256!==old.sha256||card.plan_sha256!==old.plan_sha256||card.part_index!==i)break;
  if(s.text.slice(0,a.end_char)!==old.text.slice(0,b.end_char))break;
  const np=reviewPacket(s,i),op=reviewPacket(old,i);if(np.text!==op.text||unitSig(np)!==unitSig(op))break;
  const ok=(card.items||[]).every(item=>item.evidence.every(e=>s.text.slice(e.start_char,e.end_char)===e.quote&&np.units.some(u=>u.message_id===e.message_id&&u.role===e.role&&e.start_char>=u.clipped_start&&e.end_char<=u.clipped_end)));
  if(!ok)break;
  out.push({key:'part:'+String(i).padStart(5,'0'),payload:{...card,revision:s.revision,sha256:s.sha256,plan_sha256:s.plan_sha256,total_parts:s.ranges.length,total_chars:s.total_chars,inherited_from:{revision:old.revision,card_key:'part:'+String(i).padStart(5,'0')}},reviewed_at:reviewedAt?.('part:'+String(i).padStart(5,'0'))||card.reviewed_at||null});count++;
 }
 const syn=oldCards.get('synthesis');
 if(syn&&syn.revision===old.revision&&syn.sha256===old.sha256&&syn.incorporated_parts>0&&syn.incorporated_parts<=count&&syn.incorporated_parts<s.ranges.length)
  out.push({key:'synthesis',payload:{...syn,revision:s.revision,sha256:s.sha256,plan_sha256:s.plan_sha256,total_parts:s.ranges.length,total_chars:s.total_chars,synthesis_complete:false,parts_sha256:null,inherited_from:{revision:old.revision,card_key:'synthesis'}},reviewed_at:reviewedAt?.('synthesis')||null});
 return out;
}
export function synthesisPacket(s,parts,previous=null){
 const start=previous?.incorporated_parts||0,byRef=new Map(),candidate=(item,id)=>{byRef.set(id,item);return {id,kind:item.kind,text:item.text};};
 const packet={schema:'canonical-synthesis-packet-v1',source_id:s.source_id,revision:s.revision,plan_sha256:s.plan_sha256,parts_sha256:hash(parts),start_part:start,end_part:start-1,total_parts:parts.length,previous:previous?{title:previous.title,questions:previous.questions,keywords:previous.keywords,uncertainties:previous.uncertainties,candidates:previous.items.map((i,n)=>candidate(i,'a'+n))}:null,parts:[]};
 for(let i=start;i<Math.min(start+4,parts.length);i++){const c=parts[i],entry={index:i,title:c.title,questions:c.questions,uncertainties:c.uncertainties,candidates:c.items.map((item,n)=>candidate(item,'p'+i+'i'+n))};packet.parts.push(entry);packet.end_part=i;if(JSON.stringify(packet).length>15000){packet.parts.pop();for(const c of entry.candidates)byRef.delete(c.id);packet.end_part=i-1;break;}}
 if(packet.end_part<start)throw Error('Карточка части превышает размер пакета синтеза');
 packet.output_contract={title:'общий заголовок',questions:['до 5'],keywords:['до 20'],items:[{kind:'точный kind кандидатов',text:'до 400 символов',refs:['id кандидатов, 1–4']}],uncertainties:['до 5']};return {packet,byRef};
}
export function validateSynthesis(v,s,parts,previous){
 const {packet,byRef}=synthesisPacket(s,parts,previous),fields=meta(v);if(!Array.isArray(v.items)||v.items.length>8)throw Error('Неверный синтез');
 const rejected=[];const items=v.items.flatMap((i,itemIndex)=>{try{if(!Array.isArray(i.refs)||i.refs.length<1||i.refs.length>4)throw Error('Нет проверенных ссылок синтеза');const originals=i.refs.map(id=>byRef.get(id));if(originals.some(o=>!o||o.kind!==i.kind))throw Error('Синтез меняет автора или ссылается на неизвестный пункт');const evidence=[...new Map(originals.flatMap(o=>o.evidence).map(e=>[JSON.stringify(e),e])).values()].slice(0,4);return [{kind:i.kind,text:str(i.text,400,'item'),evidence,part_refs:i.refs}];}catch(e){rejected.push({item_index:itemIndex,reason:e.message});return [];}});
 if(v.items.length&&!items.length)throw Error(rejected[0]?.reason||'Нет подтверждённых пунктов синтеза');
 if(!items.length&&(fields.questions.length||fields.keywords.length))throw Error('Пустой синтез не может добавлять термины');
 const rejectedSource=parts.reduce((n,p)=>n+(p.validation?.rejected_items||0),0),rejectedSynthesis=(previous?.validation?.rejected_synthesis_items||0)+rejected.length;
 return {schema:'source-card-synthesis-v1',reviewer:'gpt-6-luna',source_kind:s.source_kind,path:s.path,sha256:s.sha256,revision:s.revision,coverage:'all-reviewed-parts',plan_sha256:s.plan_sha256,parts_sha256:packet.parts_sha256,total_chars:s.total_chars,total_parts:parts.length,incorporated_parts:packet.end_part+1,synthesis_complete:packet.end_part+1===parts.length,...fields,items,...(rejectedSource+rejectedSynthesis?{validation:{status:'verified-with-omissions',rejected_items:rejectedSource+rejectedSynthesis,rejected_source_items:rejectedSource,rejected_synthesis_items:rejectedSynthesis,errors:rejected}}:{}),summary:items.slice(0,3).map(i=>i.text).join(' '),evidence_format:'canonical-message-transcript-v1'};
}
