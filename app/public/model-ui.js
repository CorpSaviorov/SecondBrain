const $=s=>document.querySelector(s);
export async function loadModelSettings(api,toast){
 const status=await api('/api/model'),c=status.config;
 for(const [id,value]of Object.entries({'base-url':c.base_url,model:c.model,reasoning:c.reasoning_effort,protocol:c.protocol,budget:c.monthly_limit_usd,input:c.input_usd_per_million??'',output:c.output_usd_per_million??'', 'billing-mode':c.billing_mode,multiplier:c.balance_multiplier??'', 'unit-price':c.rub_per_million_balance_units??'',fx:c.rub_per_usd??'',margin:c.billing_margin}))$('#model-'+id).value=value;
 $('#model-key').value='';$('#model-key').placeholder=status.key_saved?'Ключ сохранён. Вставьте новый для замены':'Вставьте API-ключ провайдера';
 $('#model-key-state').textContent=status.key_saved?'Ключ сохранён на компьютере':'Ключ ещё не добавлен';
 $('#model-billing-basis').textContent=c.billing_basis||'';
 const billingFields=()=>{$('#model-balance-fields').hidden=$('#model-billing-mode').value!=='balance-units';$('#model-usd-fields').hidden=$('#model-billing-mode').value==='balance-units';};billingFields();$('#model-billing-mode').onchange=billingFields;
 $('#model-spend').textContent=(c.billing_mode==='balance-units'?'≈ $':'$')+status.accounted_usd.toFixed(4)+' из $'+c.monthly_limit_usd+' · '+status.month;
 $('#model-processing-state').textContent=status.automatic_processing_active?'Обработка Luna включена в приложении. Очередь и результаты — в разделе «Обработка».':!status.tariff_confirmed?'Обработка ожидает подтверждённый тариф. Очередь сохранена.':'Автоматическая обработка на паузе. Управление — в разделе «Обработка».';
 $('#model-form').onsubmit=async event=>{
  event.preventDefault();const button=$('#save-model');button.disabled=true;
  const body={base_url:$('#model-base-url').value.trim(),model:$('#model-model').value.trim(),reasoning_effort:$('#model-reasoning').value,protocol:$('#model-protocol').value,monthly_limit_usd:Number($('#model-budget').value),input_usd_per_million:$('#model-input').value===''?null:Number($('#model-input').value),output_usd_per_million:$('#model-output').value===''?null:Number($('#model-output').value)};
  Object.assign(body,{billing_mode:$('#model-billing-mode').value,balance_multiplier:$('#model-multiplier').value===''?null:Number($('#model-multiplier').value),rub_per_million_balance_units:$('#model-unit-price').value===''?null:Number($('#model-unit-price').value),rub_per_usd:$('#model-fx').value===''?null:Number($('#model-fx').value),billing_margin:Number($('#model-margin').value)});
  if($('#model-key').value.trim())body.api_key=$('#model-key').value.trim();
  try{await api('/api/model',body);$('#model-key').value='';toast('Настройки Luna сохранены');await loadModelSettings(api,toast);}catch(e){toast(e.message);}finally{button.disabled=false;}
 };
 $('#check-model').onclick=async()=>{
  const button=$('#check-model');button.disabled=true;$('#model-check-result').textContent='Проверяем ключ и каталог моделей…';
  try{const r=await api('/api/model/check',{});$('#model-check-result').textContent=r.message;const list=$('#model-list');list.replaceChildren(...r.models.map(id=>{const o=document.createElement('option');o.value=id;return o;}));}
  catch(e){$('#model-check-result').textContent=e.message;}finally{button.disabled=false;}
 };
}
