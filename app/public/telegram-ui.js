// Telegram card: bot token, chat approval by code, connected chats. The token never comes back to the page.
export function telegramForm(c, esc) {
  return `<form class="mail-form" data-tg-form="${esc(c.id)}">
 <ol class="mail-steps">
  <li>В Telegram откройте <b>@BotFather</b> → <code>/newbot</code> → придумайте имя и адрес бота (на <code>bot</code>).</li>
  <li>Скопируйте токен из ответа BotFather (вида <code>1234567890:AAH…</code>) и вставьте ниже.</li>
  <li>Напишите своему боту <code>/start</code> — он пришлёт код. Подтвердите код здесь.</li>
  <li>Для группы: добавьте бота в группу и сделайте администратором (или у BotFather: <code>/setprivacy</code> → Disable).</li>
 </ol>
 <label>Токен бота<input type="password" name="token" autocomplete="off" placeholder="Вставьте при первом подключении или замене"></label>
 <p class="mail-secret-status" data-tg-secret>Токен хранится отдельно от базы и не возвращается на страницу.</p>
 <div class="connection-actions"><button class="btn primary" type="submit">Сохранить и проверить</button><button class="btn ghost" type="button" data-tg-webhook hidden>Отключить вебхук</button></div>
 <div data-tg-status></div>
</form>`;
}

export function bindTelegram({api, toast, refresh, render, esc}) {
  for (const form of document.querySelectorAll('[data-tg-form]')) {
    let webhookToken = '';
    const box = form.querySelector('[data-tg-status]'), secret = form.querySelector('[data-tg-secret]'), hook = form.querySelector('[data-tg-webhook]');
    const show = s => {
      secret.textContent = s.token_saved ? `Токен сохранён${s.bot ? ' — бот @' + s.bot.username : ''}. Оставьте поле пустым, если менять не нужно.` : 'Токен ещё не сохранён.';
      const when = t => new Date(t * 1000).toLocaleTimeString('ru-RU', {hour: '2-digit', minute: '2-digit'});
      box.innerHTML = [
        ...s.warnings.map(w => `<p class="mail-input-warning">${esc(w)}</p>`),
        s.last_error ? `<p class="cc-extra connector-error">${esc(s.last_error.message)}</p>` : '',
        s.pending.length ? `<h4>Ждут подтверждения</h4>` + s.pending.map(p => `<div class="tg-row"><span>${esc(p.title)} <small>(${esc(p.type)}, код до ${when(p.expires)})</small></span><input inputmode="numeric" maxlength="6" placeholder="код из чата" data-tg-code="${esc(p.id)}"><button class="btn" type="button" data-tg-approve="${esc(p.id)}">Подтвердить</button></div>`).join('') : '',
        s.allowed.length ? `<h4>Подключённые чаты</h4>` + s.allowed.map(p => `<div class="tg-row"><span>${esc(p.title)} <small>(${esc(p.type)})</small></span><button class="btn ghost" type="button" data-tg-forget="${esc(p.id)}">Отключить</button></div>`).join('') : (s.token_saved ? '<p class="mail-hint">Пока нет подключённых чатов. Напишите боту /start.</p>' : ''),
        s.removed.length ? `<p class="mail-hint">Бота удалили из: ${s.removed.map(p => esc(p.title)).join(', ')}. Сохранённое осталось в базе.</p>` : '',
        s.last_poll ? `<p class="mail-hint">Последняя проверка Telegram: ${new Date(s.last_poll).toLocaleTimeString('ru-RU')}</p>` : ''
      ].join('');
      hook.hidden = !/вебхук/i.test(s.last_error?.message || '');
      box.querySelectorAll('[data-tg-approve]').forEach(b => b.onclick = async () => {
        const code = box.querySelector(`[data-tg-code="${CSS.escape(b.dataset.tgApprove)}"]`).value;
        try { show(await api('/api/telegram/approve', {chat_id: b.dataset.tgApprove, code})); toast('Чат подключён. Бот написал об этом в чат.'); } catch (e) { toast(e.message); }
      });
      box.querySelectorAll('[data-tg-forget]').forEach(b => b.onclick = async () => {
        if (!confirm('Перестать сохранять сообщения из этого чата? Уже сохранённое останется в базе.')) return;
        try { show(await api('/api/telegram/forget', {chat_id: b.dataset.tgForget})); } catch (e) { toast(e.message); }
      });
    };
    const load = () => api('/api/telegram/status').then(show).catch(() => {});
    load();
    form.onsubmit = async e => {
      e.preventDefault();
      const token = form.elements.token.value.trim(); form.elements.token.value = '';
      if (!token) { load(); toast('Вставьте токен от @BotFather'); return; }
      toast('Проверяю токен в Telegram…');
      try { const s = await api('/api/telegram/token', {token}); show(s); toast('Бот @' + s.bot.username + ' подключён. Напишите ему /start.'); }
      catch (err) { toast(err.message); if (/вебхук/i.test(err.message)) { hook.hidden = false; webhookToken = token; } }
      finally { await refresh(); render(); }
    };
    hook.onclick = async () => {
      if (!confirm('Отключить вебхук? Если этого бота использует другая программа, она перестанет получать сообщения.')) return;
      try { const s = await api('/api/telegram/token', {token: webhookToken, delete_webhook: true}); webhookToken = ''; show(s); toast('Вебхук отключён, бот подключён.'); }
      catch (err) { toast(err.message); }
    };
    // Pending codes appear a few seconds after /start: refresh the list while the card is open.
    const timer = setInterval(() => { if (!document.body.contains(form)) clearInterval(timer); else if (form.closest('details')?.open) load(); }, 5000);
  }
}
