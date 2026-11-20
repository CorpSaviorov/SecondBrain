import {loadModelSettings} from './model-ui.js';
import {KnowledgeGraph} from './graph.js';
const $=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)];
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt=n=>Number(n||0).toLocaleString('ru-RU');
const date=v=>v?new Date(v).toLocaleDateString('ru-RU',{day:'numeric',month:'short',year:'numeric',timeZone:'Europe/Moscow'}):'Дата не указана';
const names={chatgpt:'ChatGPT',claude:'Claude',obsidian:'Obsidian',codex:'Codex','claude-code':'Claude Code',email:'Почта',topic:'Тема'};
const colors={chatgpt:'#62cfb5',claude:'#f1ad81',obsidian:'#ae8bfa',codex:'#79adf3','claude-code':'#dc997e',email:'#e5bd70',topic:'#dacb81'};
const states={ready:'Работает',complete:'Завершено','archive-imported':'Архив перенесён','not-connected':'Не подключено',partial:'Нужна проверка',error:'Ошибка',disabled:'Отключено',syncing:'Сбор выполняется','awaiting-adapter':'Ожидает отдельного сборщика'};
let graphMode='projects',graphData;
let stats,provider='',view='graph',query='',offset=0,graph,detailId,searchRequest=0;
async function api(url,body){const r=await fetch(url,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),v=await r.json();if(!r.ok)throw Error(v.error||'Не удалось выполнить запрос');return v;}
let toastTimer;function toast(text){$('#toast').textContent=text;$('#toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').hidden=true,6000);}
const label=p=>`<span class="provider-label"><i style="--dot:${colors[p]||'#aaa'}"></i>${esc(names[p]||p)}</span>`;
const titles={model:['Модель Luna','Модель для вашей памяти.','Подключение, ключ и параметры рассуждений — в одном месте.','MODEL SETTINGS'],graph:['Граф знаний','Всё связано.','Ваши мысли, разговоры и заметки — в одном пространстве.','KNOWLEDGE GRAPH'],overview:['Обзор','Память в деталях.','Источники, история и состояние обработки.','OVERVIEW'],records:['Все записи','Найдётся нужное.','Оригинальные материалы и проверенные карточки в общей базе.','RECORDS'],assets:['Вложения','Больше, чем текст.','Зарегистрированные файлы из сохранённых разговоров.','ATTACHMENTS'],connections:['Источники','Все потоки вместе.','Подключения, прямой сбор и импорт архивов.','CONNECTIONS']};
async function show(next){view=next;$('#stats').hidden=next==='model';const t=titles[next];$('#crumb').textContent=t[0];$('#page-title').textContent=t[1];$('#page-description').textContent=t[2];$('#eyebrow').textContent=t[3];$$('.view').forEach(e=>e.hidden=e.id!==next+'-view');$$('.nav').forEach(e=>e.classList.toggle('active',e.dataset.view===next));if(next==='graph'){if(!graph)graph=new KnowledgeGraph($('#graph'),{onSource:openDetail,onProject:openProject});await loadGraph();}if(next==='records')await loadRecords();if(next==='assets')await loadAssets();if(next==='overview')renderOverview();if(next==='connections')renderConnections();if(next==='model')await loadModelSettings(api,toast);}
function renderStats(){
 const cards=[['Источников в памяти',stats.sources,'Общая база всех подключений','◈'],['Источников с обзором',stats.reviewed_sources,'Обзоры текущих версий','✧'],['Карточек и частей',stats.cards,'Сохранённые результаты Luna','▤'],['Вложений',stats.assets,'Файлы учитываются отдельно','▧']];
 $('#stats').innerHTML=cards.map(([title,n,note,icon])=>`<article class="stat"><span class="stat-label">${title}</span><span class="stat-mark">${icon}</span><div class="stat-value">${fmt(n)}</div><div class="stat-note">${note}</div></article>`).join('');
 $('#nav-count').textContent=fmt(stats.sources);$('#providers').innerHTML=stats.providers.map(p=>`<button class="provider ${provider===p.provider?'selected':''}" data-provider="${p.provider}"><i style="--dot:${colors[p.provider]}"></i>${esc(names[p.provider]||p.provider)}<small>${fmt(p.count)}</small></button>`).join('');
 $$('.provider').forEach(b=>b.onclick=()=>selectProvider(b.dataset.provider));$('#footer-status').textContent=`Единая БД · ${fmt(stats.sources)} источников · Исходники сохранены`;
}
async function refresh(){stats=await api('/api/stats');renderStats();}
async function selectProvider(p){provider=provider===p?'':p;renderStats();if(view==='graph')await loadGraph();else{await show('records');}}
async function loadGraph(){
 const data=await api('/api/graph?'+new URLSearchParams({provider,limit:$('#graph-limit').value,mode:graphMode}));
 graphData=data;graph.setData(data,$('#topics').checked);
}
function recordHTML(r){return `<button class="record" data-record="${esc(r.id)}"><div class="record-head">${label(r.provider)}<time>${date(r.source_date)}</time></div><h3>${esc(r.title)}</h3>${r.snippet?`<p>${esc(r.snippet)}</p>`:''}<div class="record-bottom"><span class="${r.cards?'has-card':''}">${r.cards?'✧ '+fmt(r.cards)+' карточек / частей':'Оригинал · обзор не сохранён'}</span>${r.score!==undefined?`<span>BM25: ${r.rank_factors.lexical.toFixed(2)}</span>`:''}${r.match_type==='source-card'?'<span>Найдено через карточку</span>':''}</div></button>`;}
async function loadRecords(append=false){
 const request=++searchRequest;if(!append)offset=0;
 const params={provider,limit:100,offset,since:$('#since').value};let data;$('#ranking').disabled=!query;
 if(query){data=await api('/api/search?'+new URLSearchParams({...params,q:query,ranking:$('#ranking').value,since:$('#since').value}));}
 else data=await api('/api/sources?'+new URLSearchParams(params));
 if(request!==searchRequest)return;
 $('#results-title').textContent=query?`Найдено: ${fmt(data.total)}${provider?' · '+names[provider]:''}`:provider?names[provider]:'Все записи';
 const html=data.results.map(recordHTML).join('')||'<div class="empty">Подходящих записей пока нет.<br>Попробуйте другое слово или уберите фильтр источника.</div>';
 if(append)$('#records').insertAdjacentHTML('beforeend',html);else $('#records').innerHTML=html;
 offset+=data.results.length;$('#more-records').hidden=Boolean(query)||data.results.length<100;
 $$('#records [data-record]').forEach(e=>e.onclick=()=>openDetail(e.dataset.record));
}
function renderOverview(){
 const max=Math.max(...stats.timeline.map(r=>r.count),1);$('#timeline').innerHTML=stats.timeline.map(r=>`<div class="month"><b>${fmt(r.count)}</b><div class="bar" style="height:${Math.max(2,r.count/max*130)}px"></div><span>${r.month.slice(5)}.${r.month.slice(2,4)}</span></div>`).join('');
 const pct=stats.sources?stats.reviewed_sources/stats.sources*100:0;
 $('#coverage').innerHTML=`<div class="coverage-number">${pct.toFixed(1)}<small style="font-size:20px">%</small></div><div class="coverage-bar"><div style="width:${pct}%"></div></div><div class="coverage-note">${fmt(stats.reviewed_sources)} из ${fmt(stats.sources)} источников имеют сохранённый обзор текущей версии.<br>Обзор части не означает полного разбора источника.</div>`;
 $('#overview-connectors').innerHTML=stats.connectors.filter(c=>names[c.id]).map(c=>`<div class="connector-line">${label(c.id)}<span class="state ${c.status}">${esc(states[c.status]||c.status)}</span><time>${date(c.updated_at)}</time></div>`).join('');
}
function renderConnections(){
 const p=new Map(stats.providers.map(p=>[p.provider,p.count]));$('#connectors').innerHTML=stats.connectors.map(c=>`<article class="connection-card" style="--dot:${colors[c.provider]||'#aaa'}"><div class="connection-top"><div class="connection-icon">${c.provider==='email'?'✉':c.provider==='obsidian'?'◈':'◌'}</div><label class="source-switch"><input type="checkbox" data-toggle="${esc(c.id)}" ${c.enabled?'checked':''} aria-label="Подключение ${esc(c.name)}"><span></span></label></div><h3>${esc(c.name)}</h3><span class="state ${c.status}">${esc(states[c.status]||c.status)}</span><p>${fmt(p.get(c.provider)||0)} источников сохранено<br>${!c.enabled?'Сбор остановлен · данные доступны':c.driver==='push'?'Прямой приём в БД · сборщик подключается отдельно':'Независимый сборщик → единая БД'}</p>${c.payload.message?`<p class="connector-error">${esc(c.payload.message)}</p>`:''}<small>Последний результат: ${date(c.state_updated_at)}</small>${c.collectable?`<div class="connection-actions"><button class="button" data-collect="${esc(c.id)}" ${!c.enabled?'disabled':''}>Обновить источник</button></div><details class="connector-settings"><summary>Папки источника</summary><textarea data-paths="${esc(c.id)}" rows="3" aria-label="Папки ${esc(c.name)}">${esc(c.config.root||(c.config.roots||[]).join('\n'))}</textarea><button class="button" data-save-paths="${esc(c.id)}">Сохранить папки</button></details>`:''}</article>`).join('');
 $$('[data-toggle]').forEach(input=>input.onchange=async()=>{try{await api('/api/connectors/'+encodeURIComponent(input.dataset.toggle),{enabled:input.checked});await refresh();renderConnections();toast(input.checked?'Подключение включено':'Сбор отключён. Сохранённые данные доступны.');}catch(e){toast(e.message);await refresh();renderConnections();}});
 $$('[data-collect]').forEach(button=>button.onclick=async()=>{button.disabled=true;try{const result=await api('/api/collect/'+encodeURIComponent(button.dataset.collect),{});toast(result.error||`Изменений: ${fmt(result.changed)}`);await refresh();renderConnections();}catch(e){toast(e.message);button.disabled=false;}});
 $$('[data-save-paths]').forEach(button=>button.onclick=async()=>{const c=stats.connectors.find(c=>c.id===button.dataset.savePaths),value=$$('[data-paths]').find(e=>e.dataset.paths===c.id).value.trim(),config=c.driver==='markdown-folder'?{root:value}:{roots:value.split(/\r?\n/).map(p=>p.trim()).filter(Boolean)};try{await api('/api/connectors/'+encodeURIComponent(c.id),{config});await refresh();renderConnections();toast('Папки сохранены');}catch(e){toast(e.message);}});
}
async function loadAssets(){const data=await api('/api/assets');$('#asset-count').textContent=`${fmt(data.total)} зарегистрировано${data.total>500?' · первые 500':''}`;$('#assets').innerHTML=data.results.map(a=>`<article class="record"><div class="record-head"><span class="provider-label">▧ Вложение</span><time>${a.bytes!==null?fmt(Math.round(a.bytes/1024))+' КБ':'Размер неизвестен'}</time></div><h3>${esc(a.name)}</h3><div class="record-bottom"><span>${a.state==='saved-unread'?'Сохранено · содержание ещё не разобрано':a.state==='missing'?'Файл отсутствует локально':'Зарегистрировано'}</span></div>${a.state==='saved-unread'?`<a class="asset-link" href="/api/asset?id=${encodeURIComponent(a.id)}">Открыть / сохранить файл ↗</a>`:''}</article>`).join('')||'<div class="empty">Вложений пока нет</div>';}
function openProject(project){
 $('#detail').hidden=false;$('#detail-provider').textContent=project.type==='project'?'Проект / папка':'Группа материалов';
 const records=(graphData?.nodes||[]).filter(n=>n.type==='source'&&n.project_id===project.id);
 $('#detail-content').innerHTML='<h2>'+esc(project.label)+'</h2><p class="notice">'+fmt(project.count)+' материалов. Группировка по папкам источников или вашему назначению.</p><button id="focus-project" class="button">Показать связи группы</button><div class="detail-section-label">ЗАПИСИ ГРУППЫ</div>'+records.slice(0,100).map(r=>'<button class="record" data-project-source="'+esc(r.id)+'"><h3>'+esc(r.label)+'</h3></button>').join('')+(records.length>100?'<p class="notice">Показаны первые 100 записей.</p>':'');
 $('#focus-project').onclick=()=>{graph.selected=graph.allById.get(project.id);graph.local=true;graph.fit();$('#detail').hidden=true;};
 $$('[data-project-source]').forEach(b=>b.onclick=()=>openDetail(b.dataset.projectSource));
}

async function openDetail(id){
 if(id.startsWith('topic:')){query=id.slice(6);$('#search').value=query;await show('records');return;}
 detailId=id;const d=await api('/api/source?'+new URLSearchParams({id}));$('#detail').hidden=false;$('#detail-provider').textContent=names[d.provider]||d.provider;
 const c=d.card,part=c?.schema==='source-card-part-v1',synthesis=c?.schema==='source-card-synthesis-v1',kindNames={user_goal:'Цель пользователя',user_decision:'Решение пользователя',user_question:'Вопрос пользователя',user_statement:'Сообщение пользователя',assistant_suggestion:'Предложение ассистента',assistant_report:'Отчёт ассистента',note_statement:'Запись в заметке',note_question:'Вопрос в заметке'};
 let guide='';if(c){guide=`<div class="detail-section-label">${part?'ОБЗОР ЧАСТИ ИСТОЧНИКА':synthesis?'ОБЩИЙ СИНТЕЗ':'КАРТОЧКА ИСТОЧНИКА'}</div><div class="card-summary">${part?'<p class="notice">Обзор охватывает только указанную часть разговора.</p>':''}${(c.items||[]).map(i=>`<div class="card-item"><div class="card-kind">${esc(kindNames[i.kind]||i.kind)}</div>${esc(i.text)}${(i.evidence||[]).slice(0,1).map(e=>`<div><button class="evidence-btn" data-evidence-offset="${Number(e.start_char)||0}" data-evidence-sha="${esc(c.sha256)}">Цитата · ${esc(e.role)}${e.lines?' · строки '+e.lines.join('–'):''} ↗</button></div>`).join('')}</div>`).join('')||esc(c.summary||c.title||'Пустой обзор')}${c.uncertainties?.length?`<p class="notice">Не подтверждено: ${esc(c.uncertainties.join(' '))}</p>`:''}</div><div class="detail-keywords">${(c.keywords||[]).map(t=>`<span>${esc(t)}</span>`).join('')}</div>`;}
 $('#detail-content').innerHTML=`<h2>${esc(d.title)}</h2><div class="detail-meta">Дата источника: ${date(d.source_date)}<br>${fmt(d.message_count)} сообщений · ${fmt(d.total_chars)} символов${d.coverage.partial?'<br>Сохранена часть разговора':''}</div>${guide}<div class="detail-section-label">ИСХОДНЫЙ ТЕКСТ</div>${!c?'<p class="notice">Для этой версии обзор пока не сохранён. Ниже — оригинальный текст.</p>':''}<pre id="source-text"></pre><button id="more-source" class="button" ${d.next_offset===null?'hidden':''}>Продолжить чтение</button><div class="detail-section-label">ПРОИСХОЖДЕНИЕ</div><div class="detail-meta">${esc(d.source_path||'Прямое поступление в БД')}<br>ID: ${esc(d.id)}<br>Версия: ${esc(d.revision.slice(0,16))}</div><button id="copy-id" class="evidence-btn">Скопировать ID источника</button>`;
 $('#source-text').textContent=d.body;let next=d.next_offset;$('#more-source').onclick=async()=>{const p=await api('/api/source?'+new URLSearchParams({id,offset:next}));if(detailId!==id)return;$('#source-text').textContent+=p.body;next=p.next_offset;$('#more-source').hidden=next===null;};
 $('#copy-id').onclick=async()=>{try{await navigator.clipboard.writeText(id);toast('ID скопирован');}catch{toast(id);}};
 $$('[data-evidence-offset]').forEach(b=>b.onclick=async()=>{try{const e=await api('/api/evidence?'+new URLSearchParams({id,sha:b.dataset.evidenceSha,offset:Math.max(0,Number(b.dataset.evidenceOffset)-150)}));$('#source-text').textContent=e.text;$('#more-source').hidden=true;$('#source-text').scrollIntoView({behavior:'smooth',block:'start'});}catch(e){toast(e.message);}});
}


$$('.nav').forEach(b=>b.onclick=()=>show(b.dataset.view).catch(e=>toast(e.message)));
$('#clear-provider').onclick=async()=>{provider='';renderStats();await show(view);};
$('#search-form').onsubmit=async e=>{e.preventDefault();query=$('#search').value.trim();await show('records');};
$('#search').oninput=()=>{if(!$('#search').value&&query){query='';if(view==='records')loadRecords().catch(e=>toast(e.message));}};
$('#ranking').onchange=$('#since').onchange=()=>loadRecords().catch(e=>toast(e.message));
$('#more-records').onclick=()=>loadRecords(true).catch(e=>toast(e.message));
$('#close-detail').onclick=()=>{$('#detail').hidden=true;detailId=null;};
$('#graph-limit').onchange=$('#topics').onchange=()=>loadGraph().catch(e=>toast(e.message));
$('#fit').onclick=()=>graph?.fit();$('#zoom-in').onclick=()=>{if(graph)graph.scale=Math.min(5,graph.scale*1.25);};$('#zoom-out').onclick=()=>{if(graph)graph.scale=Math.max(.12,graph.scale*.8);};
$('#pause').onclick=()=>{if(graph){graph.paused=!graph.paused;$('#pause').textContent=graph.paused?'▷':'Ⅱ';}};
$('#all-graph').onclick=()=>{graphMode='projects';$('#flat-graph').classList.remove('selected');loadGraph().catch(e=>toast(e.message));if(graph){graph.local=false;graph.selected=null;}$('#all-graph').classList.add('selected');$('#related-graph').classList.remove('selected');};
$('#related-graph').onclick=()=>{if(!graph?.selected)return toast('Сначала выберите узел на графе');graph.local=true;$('#related-graph').classList.add('selected');$('#all-graph').classList.remove('selected');};
$('#sync').onclick=async()=>{const b=$('#sync');b.disabled=true;try{toast('Проверяем включённые источники…');const r=await api('/api/sync',{});await refresh();await show(view);const failed=(r.results||[]).filter(r=>r.error).length;toast(`Обновлено: ${fmt(r.changed||0)}.${failed?' Недоступных подключений: '+failed+'. Остальные работают.':''} Модельных вызовов нет.`);}catch(e){toast(e.message);}finally{b.disabled=false;}};
$('#import-button').onclick=()=>$('#import-file').click();$('#import-file').onchange=async e=>{const f=e.target.files[0];if(!f)return;try{const raw=JSON.parse(await f.text()),r=await api('/api/ingest',{data:raw,transport:'user-export'});toast(`Импортировано ${fmt(r.imported)}, изменено ${fmt(r.changed)}`);await refresh();renderConnections();}catch(e){toast(e.message);}e.target.value='';};
document.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='k'){e.preventDefault();$('#search').focus();}if(e.key==='Escape')$('#close-detail').click();});
$('#date-label').textContent=new Date().toLocaleDateString('ru-RU',{day:'numeric',month:'long',year:'numeric',timeZone:'Europe/Moscow'});
try{await refresh();await show('graph');}catch(e){$('#footer-status').textContent='База временно недоступна';toast(e.message);}

$('#flat-graph').onclick=()=>{graphMode='all';$('#all-graph').classList.remove('selected');$('#flat-graph').classList.add('selected');loadGraph().catch(e=>toast(e.message));};
$('#graph-fullscreen').onclick=()=>{$('.graph-wrap').classList.toggle('fullscreen');$('#graph-fullscreen').textContent=$('.graph-wrap').classList.contains('fullscreen')?'Свернуть':'На весь экран';};

$('#graph-exit').onclick=()=>{$('.graph-wrap').classList.remove('fullscreen');$('#graph-fullscreen').textContent='На весь экран';};
document.addEventListener('keydown',e=>{if(e.key==='Escape')$('#graph-exit').click();});
