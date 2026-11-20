const status=document.querySelector('#status');
async function refresh(){const s=await chrome.runtime.sendMessage({type:'status'});status.textContent=(s.online?'Локальный SecondBrain доступен':'Запустите локальный SecondBrain')+(s.pending?' · в очереди '+s.pending:'')+(s.last?.message?'\n'+s.last.message:'');}
for(const action of ['current','recent'])document.getElementById(action).onclick=async()=>{try{const [tab]=await chrome.tabs.query({active:true,currentWindow:true});if(!/^https:\/\/(chatgpt\.com|claude\.ai)\//.test(tab?.url||''))throw Error('Откройте ChatGPT или Claude в этой вкладке');const r=await chrome.tabs.sendMessage(tab.id,{type:'run',action});status.textContent=r.ok?'Загрузка началась. Результат появится здесь.':r.error;}catch(e){status.textContent=e.message;}};
document.getElementById('retry').onclick=async()=>{const r=await chrome.runtime.sendMessage({type:'flush'});status.textContent=r.ok?'Отправлено: '+r.sent:r.error;};
refresh();setInterval(refresh,3000);
