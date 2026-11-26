// Independently implemented read-only web-account adapter. Endpoint shapes checked
// against the existing BSD-0-Clause ChatBridge source; no Obsidian runtime imports.
const uuid=v=>typeof v==='string'&&/^[a-f0-9-]{36}$/i.test(v);
const stable=x=>JSON.stringify(x,(_,v)=>v&&!Array.isArray(v)&&typeof v==='object'?Object.fromEntries(Object.entries(v).sort()):v);
export function joinChatPages(main,older){
 const seen=new Map(),messages=[];for(const m of [...older].reverse().flatMap(p=>p.messages).concat(main.messages)){if(typeof m.id!=='string')throw Error('Message identity missing');if(seen.has(m.id)){if(stable(seen.get(m.id))!==stable(m))throw Error('Messages changed between pages');continue;}seen.set(m.id,m);messages.push(m);}
 return {...main,messages,page_info:{...main.page_info,has_previous_page:false},_secondbrain:{pages:older.length+1,older_pages_exhausted:true,all_branches_verified:false}};
}
const lanes=provider=>provider==='chatgpt'?['main','tpp','archive','archive-tpp']:['main','archive'];
export async function syncAccount({provider,get,ingest,known=[],checkpoint={},save=()=>{},isEnabled=async()=>true,pause=()=>Promise.resolve(),maxRequests=35,maxChats=5,quietSeconds=300}){
 const cp=checkpoint;cp.offsets??={};cp.pending??=[];cp.progress??={};let requests=0,changed=0,captured=0,partial=0;
 const seen=new Map(known.map(k=>[k.id,k]));
 const read=async p=>{if(!await isEnabled())throw Error('Connector disabled');if(requests>=maxRequests){const e=Error('Request budget reached');e.budget=true;throw e;}requests++;await pause();return get(p);};
 const errors=[];let workLanes;
 const consider=(item,org,project,projectId)=>{const id=provider==='chatgpt'?item.id:item.uuid;if(!uuid(id))throw Error('Conversation identity missing');const updated=provider==='chatgpt'?item.update_time:item.updated_at;if(typeof updated!=='string'||Number.isNaN(Date.parse(updated)))throw Error('Source update time missing');const old=seen.get(id);if(old&&!old.partial&&Date.parse(old.updated)>=Date.parse(updated))return false;const pending=cp.pending.find(p=>p.id===id);if(!pending)cp.pending.push({id,updated,org:org||null,project:project||null,project_id:projectId||null});else{if(project&&!pending.project){pending.project=project;pending.project_id=projectId;}if(Date.parse(updated)>Date.parse(pending.updated)){pending.updated=updated;delete cp.progress[id];}}return true;};
 if(provider==='claude'){
  const orgs=await read('/api/organizations');if(!Array.isArray(orgs)||!orgs.length||orgs.some(o=>!uuid(o.uuid)))throw Error('Claude organizations unavailable');cp.orgs=orgs.filter(o=>!Array.isArray(o.capabilities)||o.capabilities.includes('chat')).map(o=>o.uuid);if(!cp.orgs.length)throw Error('No readable chat organization');
  cp.pending.forEach(p=>p.org??=cp.org||cp.orgs[0]);workLanes=cp.orgs.flatMap(org=>['main','archive'].map(lane=>({key:org+':'+lane,org,lane})));save(cp);
 }else workLanes=lanes(provider).map(lane=>({key:lane,lane}));
 cp.catalogSeen??={};const cursor=cp.laneCursor||0,ordered=[...workLanes.slice(cursor),...workLanes.slice(0,cursor)];
 for(const scope of ordered){
  if(requests>=Math.max(4,maxRequests-4))break;const {key,lane,org}=scope,backfill=cp.offsets[key]||0,archived=lane.includes('archive');
  // 2026-11-27: a history pass reads up to 5 pages per run while the request budget allows (one page per run took
  // weeks), and a finished pass is repeated at most weekly — changed chats always rise to the first page anyway.
  cp.backfillDone??={};const offsets=backfill?[0,backfill]:[0];
  for(let k=0;k<offsets.length;k++){const offset=offsets[k],isBack=k>0;
   if(requests>=Math.max(4,maxRequests-2))break;
   const route=provider==='chatgpt'?'/backend-api/conversations?'+new URLSearchParams({[lane.includes('tpp')?'conversation_origin':'exclude_conversation_origin']:'tpp',expand:'false',hide_snorlax:'false',is_archived:String(archived),is_starred:'false',limit:'20',order:'updated',offset:String(offset)}):`/api/organizations/${org}/chat_conversations_v2?limit=30&offset=${offset}&archived=${archived}&consistency=strong`;
   let page;try{page=await read(route);}catch(e){if(provider==='claude'&&e.status===403){errors.push({scope:key,error:'Organization not accessible'});break;}throw e;}
   const items=provider==='chatgpt'?page.items:page.data;if(!Array.isArray(items)||provider==='chatgpt'&&!Number.isSafeInteger(page.total)||provider==='claude'&&typeof page.has_more!=='boolean')throw Error('Conversation catalog format changed');
   const more=provider==='chatgpt'?offset+items.length<page.total:page.has_more;if(!items.length&&more)throw Error('Catalog pagination did not advance');
   for(const item of items)consider(item,org,item.project?.name,item.gizmo_id);
   if(isBack){cp.offsets[key]=more?offset+items.length:0;if(!more)cp.backfillDone[key]=Date.now();else if(k<5&&requests<maxRequests-12)offsets.push(offset+items.length);}
   else if(!backfill)cp.offsets[key]=more&&!(Date.now()-(cp.backfillDone[key]||0)<7*86400000)?items.length:0;
   cp.catalogSeen[key]=true;save(cp);
  }
  cp.laneCursor=(workLanes.findIndex(l=>l.key===key)+1)%workLanes.length;
 }
 if(provider==='chatgpt'&&requests<maxRequests-6){
  cp.projectsFull??={};let projects=[];
  try{
   let sc=null;for(let i=0;i<5;i++){const p=await read('/backend-api/gizmos/snorlax/sidebar?'+new URLSearchParams({conversations_per_gizmo:'0',owned_only:'true',...(sc?{cursor:sc}:{})}));if(!Array.isArray(p?.items))throw Error('Project list format changed');for(const it of p.items){const g=it?.gizmo?.gizmo;if(typeof g?.id==='string'&&/^g-p-[a-f\d]{32}$/i.test(g.id))projects.push({id:g.id,name:String(g.display?.name||'').trim()||null});}sc=typeof p.cursor==='string'&&p.cursor?p.cursor:null;if(!sc)break;}
   cp.projects=projects.map(p=>p.id);const start=(cp.projectIndex||0)%Math.max(1,projects.length);
   for(let k=0;k<projects.length;k++){const pr=projects[(start+k)%projects.length];if(requests>=maxRequests-3)break;
    let cursor='0',pages=0;while(cursor!=null&&requests<maxRequests-2){const p=await read('/backend-api/gizmos/'+pr.id+'/conversations?cursor='+encodeURIComponent(cursor));if(!Array.isArray(p?.items))throw Error('Project chat list format changed');pages++;let fresh=0;for(const item of p.items)if(consider(item,null,pr.name,pr.id))fresh++;
     cursor=typeof p.cursor==='string'&&p.cursor||typeof p.cursor==='number'?String(p.cursor):null;if(!cursor){cp.projectsFull[pr.id]=true;break;}if(cp.projectsFull[pr.id]&&!fresh)break;if(pages>50)throw Error('Project pagination did not stop');}
    cp.projectIndex=(start+k+1)%projects.length;save(cp);}
  }catch(e){if(!e.budget)errors.push({scope:'projects',error:e.message});}
  cp.projectsSeen=Boolean(projects.length===0||projects.every(p=>cp.projectsFull[p.id]));save(cp);
 }
 cp.pending.sort((a,b)=>Date.parse(b.updated)-Date.parse(a.updated));
 while(cp.pending.length&&captured<maxChats&&requests<maxRequests-1){
  const candidateIndex=cp.pending.findIndex(p=>Date.now()-Date.parse(p.updated)>=quietSeconds*1000);if(candidateIndex<0)break;const item=cp.pending[candidateIndex],id=item.id;let raw;
  try{
   if(provider==='chatgpt'){
    const progress=cp.progress[id]||{main:await read(`/backend-api/conversations/${id}?num_turns=10&include_has_versions=true`),older:[],cursors:[]};cp.progress[id]=progress;
    if(progress.main.conversation_id!==id||!Array.isArray(progress.main.messages)||!progress.main.page_info)throw Error('Conversation format changed');
    let p=progress.older.at(-1)||progress.main;
    while(p.page_info?.has_previous_page){const cursor=p.page_info.start_cursor;if(typeof cursor!=='string'||!cursor||progress.cursors.includes(cursor))throw Error('Older-message pagination stopped advancing');const older=await read(`/backend-api/conversations/${id}/messages?before=${encodeURIComponent(cursor)}&num_turns=10&include_has_versions=true`);if(!Array.isArray(older.messages)||!older.messages.length||typeof older.page_info?.has_previous_page!=='boolean')throw Error('Older message page format changed');progress.cursors.push(cursor);progress.older.push(older);p=older;save(cp);if(progress.older.length>500)throw Error('Conversation exceeds bounded pagination limit');}
    if(progress.main.page_info.has_next_page===true)throw Error('Newer message pages are not complete');if(progress.older.length){const latest=await read(`/backend-api/conversations/${id}?num_turns=10&include_has_versions=true`);if(latest.update_time!==progress.main.update_time||stable(latest.messages)!==stable(progress.main.messages)){delete cp.progress[id];save(cp);throw Error('Source changed while reading pages');}}
    raw=joinChatPages(progress.main,progress.older);
   }else{raw=await read(`/api/organizations/${item.org||cp.org}/chat_conversations/${id}?tree=True&rendering_mode=messages`);if(raw.uuid!==id||!Array.isArray(raw.chat_messages))throw Error('Claude conversation format changed');}
   if(!await isEnabled())break;
   if(item.project)raw._secondbrain_project_name=item.project;
   const receipt=await ingest(raw);if(receipt.pending||receipt.imported!==1)throw Error('No complete canonical receipt');changed+=receipt.changed||0;captured++;delete cp.progress[id];cp.pending.splice(candidateIndex,1);save(cp);
  }catch(e){if(!e.budget)throw e;const progress=cp.progress[id];if(progress){const staged=joinChatPages(progress.main,progress.older);staged.page_info.has_previous_page=true;staged._secondbrain.older_pages_exhausted=false;await ingest(staged);partial++;save(cp);}break;}
 }
 return {changed,captured,partial,requests,remaining:cp.pending.length,checkpoint:cp,catalog_scan_complete:workLanes.every(l=>cp.catalogSeen[l.key]&&(cp.offsets[l.key]===0||cp.backfillDone[l.key]))&&(provider!=='chatgpt'||cp.projectsSeen===true)&&!errors.length,errors,catalog_coverage:provider==='chatgpt'?'main,tpp,archive,archive-tpp; every project listed separately ('+(cp.projects?.length??'?')+' projects)':'main and archive for all returned chat-capable organizations',attachments_bytes_verified:false};
}
