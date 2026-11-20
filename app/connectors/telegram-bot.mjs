// Telegram source through the user's own bot (Bot API, long polling — no public address needed).
// - Only chats the owner confirmed in the panel (6-digit code) are saved; anything else is ignored and never stored.
// - One record per chat per local day ("Telegram · Chat · 21 нояб."), rebuilt from per-message rows, so edits and late
//   imports update the same record as a new revision. Forwarded messages keep their origin in the text.
// - Files up to 20 MB (Bot API limit) are saved as attachments; larger ones are listed by name.
// - The token is stored in store/secrets/telegram-bot.json, never in the database, API responses or logs.
import fs from 'node:fs';
import path from 'node:path';
import {randomInt, randomUUID} from 'node:crypto';
import {hash, json} from '../store.mjs';

export const TOKEN_RE = /^\d{5,15}:[A-Za-z0-9_-]{30,}$/;
const MAX_FILE = 20 * 1024 * 1024;
const ALLOWED_UPDATES = ['message', 'edited_message', 'channel_post', 'edited_channel_post', 'my_chat_member'];
const MONTHS = ['янв.', 'февр.', 'марта', 'апр.', 'мая', 'июня', 'июля', 'авг.', 'сент.', 'окт.', 'нояб.', 'дек.'];
const bots = new WeakMap();

export function telegramBot(store, registry, options) {
  let bot = bots.get(store);
  if (!bot) { bot = new TelegramBot(store, registry, options); bots.set(store, bot); }
  return bot;
}

class TelegramError extends Error {
  constructor(message, {status = 0, retryAfter = 0, needsLogin = false, conflict = null} = {}) { super(message); Object.assign(this, {status, retryAfter, needsLogin, conflict}); }
}

export function localDay(unix, timeZone = process.env.BRAIN_TZ || undefined) {
  return new Intl.DateTimeFormat('sv-SE', {timeZone, year: 'numeric', month: '2-digit', day: '2-digit'}).format(new Date(unix * 1000));
}
const dayLabel = day => { const [, m, d] = day.split('-').map(Number); return d + ' ' + MONTHS[m - 1]; };
const clock = (unix, timeZone = process.env.BRAIN_TZ || undefined) => new Intl.DateTimeFormat('ru-RU', {timeZone, hour: '2-digit', minute: '2-digit'}).format(new Date(unix * 1000));
const person = u => u ? [u.first_name, u.last_name].filter(Boolean).join(' ') || (u.username ? '@' + u.username : 'без имени') : '';
const chatName = c => c ? c.title || person(c) || (c.username ? '@' + c.username : 'чат ' + c.id) : '';

// Text of one message for the record: "[14:03] Имя: текст", forwarded origin, caption and file notes.
export function messageText(m, {files = []} = {}) {
  const lines = [];
  const origin = m.forward_origin;
  if (origin) {
    const who = origin.type === 'user' ? person(origin.sender_user) : origin.type === 'hidden_user' ? origin.sender_user_name : origin.type === 'chat' ? chatName(origin.sender_chat) : origin.type === 'channel' ? chatName(origin.chat) : 'неизвестно';
    lines.push(`Переслано от: ${who || 'неизвестно'}${origin.date ? ', ' + new Date(origin.date * 1000).toISOString().slice(0, 16).replace('T', ' ') : ''}`);
  } else if (m.forward_from || m.forward_from_chat || m.forward_sender_name) {
    lines.push('Переслано от: ' + (person(m.forward_from) || chatName(m.forward_from_chat) || m.forward_sender_name));
  }
  const body = m.text ?? m.caption ?? '';
  if (body) lines.push(body);
  if (m.location) lines.push(`[геопозиция ${m.location.latitude}, ${m.location.longitude}]`);
  if (m.contact) lines.push(`[контакт: ${person(m.contact)} ${m.contact.phone_number || ''}]`.trim());
  if (m.poll) lines.push(`[опрос: ${m.poll.question} — ${(m.poll.options || []).map(o => o.text).join(' / ')}]`);
  if (m.sticker) lines.push(`[стикер ${m.sticker.emoji || ''}]`.trim());
  for (const f of files) lines.push(f.saved ? `[файл: ${f.name}]` : `[файл не сохранён: ${f.name} — ${f.reason}]`);
  return lines.join('\n');
}

function fileOf(m) {
  if (m.document) return {id: m.document.file_id, name: m.document.file_name || 'документ', mime: m.document.mime_type, size: m.document.file_size};
  if (m.photo?.length) { const p = m.photo[m.photo.length - 1]; return {id: p.file_id, name: 'фото-' + m.message_id + '.jpg', mime: 'image/jpeg', size: p.file_size}; }
  if (m.voice) return {id: m.voice.file_id, name: 'голосовое-' + m.message_id + '.ogg', mime: m.voice.mime_type || 'audio/ogg', size: m.voice.file_size};
  if (m.audio) return {id: m.audio.file_id, name: m.audio.file_name || 'аудио-' + m.message_id, mime: m.audio.mime_type, size: m.audio.file_size};
  if (m.video) return {id: m.video.file_id, name: m.video.file_name || 'видео-' + m.message_id + '.mp4', mime: m.video.mime_type || 'video/mp4', size: m.video.file_size};
  if (m.video_note) return {id: m.video_note.file_id, name: 'кружок-' + m.message_id + '.mp4', mime: 'video/mp4', size: m.video_note.file_size};
  return null;
}
const isService = m => m.new_chat_members || m.left_chat_member || m.new_chat_title || m.new_chat_photo || m.delete_chat_photo || m.group_chat_created || m.supergroup_chat_created || m.channel_chat_created || m.pinned_message || m.message_auto_delete_timer_changed || m.migrate_from_chat_id || m.forum_topic_created || m.video_chat_started || m.video_chat_ended;

export class TelegramBot {
  constructor(store, registry, {secretDir, assetDir, fetchImpl = fetch, apiBase = process.env.BRAIN_TELEGRAM_API || 'https://api.telegram.org', sleep = ms => new Promise(r => setTimeout(r, ms))} = {}) {
    Object.assign(this, {store, registry, fetch: fetchImpl, apiBase: apiBase.replace(/\/$/, ''), sleep});
    this.secretDir = secretDir || path.join(path.dirname(store.filename), 'secrets');
    this.assetDir = assetDir || path.join(path.dirname(store.filename), 'assets');
    this.lock = Promise.resolve();
    store.db.exec(`CREATE TABLE IF NOT EXISTS telegram_messages(chat_id TEXT NOT NULL,message_id INTEGER NOT NULL,day TEXT NOT NULL,date INTEGER NOT NULL,text TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(chat_id,message_id));
      CREATE INDEX IF NOT EXISTS telegram_messages_day ON telegram_messages(chat_id,day);`);
  }
  connector() { const c = this.registry.get('telegram'); if (!c) throw Error('Источник Telegram не найден'); return c; }
  get tokenFile() { return path.join(this.secretDir, 'telegram-bot.json'); }
  token() { try { return JSON.parse(fs.readFileSync(this.tokenFile, 'utf8')).token || null; } catch { return null; } }
  meta(key, fallback) { const r = this.store.db.prepare('SELECT value FROM brain_meta WHERE key=?').get('telegram:' + key); return r ? JSON.parse(r.value) : fallback; }
  setMeta(key, value) { this.store.db.prepare('INSERT INTO brain_meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('telegram:' + key, JSON.stringify(value)); }
  chats() { return this.meta('chats', {}); }
  saveChats(chats) { this.setMeta('chats', chats); }

  async call(method, params = {}, {timeoutMs = 30000, token = this.token()} = {}) {
    if (!token) throw new TelegramError('Сначала вставьте токен бота', {needsLogin: true});
    let response;
    try {
      response = await this.fetch(`${this.apiBase}/bot${token}/${method}`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(params), signal: AbortSignal.timeout(timeoutMs)});
    } catch (e) {
      const code = e.name === 'TimeoutError' ? 'timeout' : e.cause?.code || 'network';
      throw new TelegramError(`Нет связи с api.telegram.org (${code}). Проверьте интернет; если Telegram заблокирован в вашей сети — включите VPN/прокси на этом компьютере.`);
    }
    let v; try { v = await response.json(); } catch { throw new TelegramError('Telegram вернул непонятный ответ (' + response.status + ')', {status: response.status}); }
    if (v.ok) return v.result;
    const d = String(v.description || '');
    if (v.error_code === 401 || v.error_code === 404) throw new TelegramError('Токен не принят Telegram. Скопируйте токен у @BotFather заново (команда /mybots → бот → API Token). Если токен перевыпускали, старый больше не работает.', {status: 401, needsLogin: true});
    if (v.error_code === 409 && /webhook/i.test(d)) throw new TelegramError('У бота включён вебхук: сообщения уходят другой программе. Используйте отдельного бота для SecondBrain или отключите вебхук кнопкой «Отключить вебхук» (другая программа перестанет получать сообщения).', {status: 409, conflict: 'webhook'});
    if (v.error_code === 409) throw new TelegramError('Этого бота уже читает другая программа или второй запущенный SecondBrain. У бота может быть только один читатель: остановите другую программу или создайте отдельного бота.', {status: 409, conflict: 'polling'});
    if (v.error_code === 429) throw new TelegramError('Telegram просит подождать ' + (v.parameters?.retry_after || 5) + ' с', {status: 429, retryAfter: v.parameters?.retry_after || 5});
    if (v.error_code === 403) throw new TelegramError('Бот не может писать в этот чат (его удалили или заблокировали)', {status: 403});
    throw new TelegramError('Telegram: ' + d.slice(0, 200), {status: v.error_code});
  }
  // Every Bot API exchange that moves the update offset goes through one lock: two getUpdates at once are a 409.
  exclusive(fn) { const run = this.lock.then(fn, fn); this.lock = run.catch(() => {}); return run; }

  status() {
    const c = this.connector(), chats = this.chats(), now = Date.now() / 1000;
    const list = Object.entries(chats).map(([id, x]) => ({id, title: x.title, type: x.type, state: x.state, ...(x.state === 'pending' ? {expires: x.expires} : {})})).filter(x => x.state !== 'pending' || x.expires > now);
    const bot = this.meta('bot', null), groups = list.some(x => x.state === 'allowed' && x.type !== 'private' && x.type !== 'channel');
    return {enabled: c.enabled, token_saved: Boolean(this.token()), bot: bot && {username: bot.username, can_read_all_group_messages: bot.can_read_all_group_messages},
      warnings: [...(groups && bot && !bot.can_read_all_group_messages ? ['Бот в группе видит только команды и ответы на свои сообщения. У @BotFather: /setprivacy → бот → Disable, затем удалите бота из группы и добавьте снова. Или сделайте бота администратором группы.'] : [])],
      allowed: list.filter(x => x.state === 'allowed'), pending: list.filter(x => x.state === 'pending').map(({id, title, type, expires}) => ({id, title, type, expires})), removed: list.filter(x => x.state === 'removed'),
      last_poll: this.meta('last_poll', null), last_error: this.meta('last_error', null)};
  }

  async saveToken(raw, {deleteWebhook = false} = {}) {
    const token = String(raw || '').trim().replace(/^bot/i, '');
    if (!TOKEN_RE.test(token)) throw new TelegramError('Это не похоже на токен бота. Он выглядит так: 1234567890:AAH…(около 46 символов). Скопируйте его целиком из сообщения @BotFather.');
    return this.exclusive(async () => {
      const me = await this.call('getMe', {}, {token});
      if (!me.is_bot) throw new TelegramError('Этот токен не принадлежит боту');
      if (deleteWebhook) await this.call('deleteWebhook', {drop_pending_updates: false}, {token});
      const hook = await this.call('getWebhookInfo', {}, {token});
      if (hook.url) throw new TelegramError('У бота включён вебхук: сообщения уходят другой программе. Используйте отдельного бота для SecondBrain или нажмите «Отключить вебхук» (другая программа перестанет получать сообщения).', {status: 409, conflict: 'webhook'});
      const previous = this.meta('bot', null);
      fs.mkdirSync(this.secretDir, {recursive: true});
      const temporary = this.tokenFile + '.tmp-' + randomUUID();
      fs.writeFileSync(temporary, JSON.stringify({token}), {mode: 0o600, flag: 'wx'}); fs.renameSync(temporary, this.tokenFile);
      if (previous && previous.id !== me.id) { this.setMeta('offset', 0); this.saveChats(Object.fromEntries(Object.entries(this.chats()).filter(([, x]) => x.state === 'allowed'))); }
      this.setMeta('bot', {id: me.id, username: me.username, can_read_all_group_messages: Boolean(me.can_read_all_group_messages)});
      this.setMeta('last_error', null);
      this.registry.configure('telegram', {enabled: true, config: {bot_username: me.username}});
      this.store.state('telegram', 'ready', {message: 'Бот @' + me.username + ' подключён. Напишите ему /start', driver: 'telegram-bot'});
      return this.status();
    });
  }

  async approve(chatId, code) {
    const chats = this.chats(), x = chats[String(chatId)];
    if (!x || x.state !== 'pending' || x.expires < Date.now() / 1000) throw new TelegramError('Запрос устарел. Напишите боту в этом чате ещё раз — придёт новый код.');
    if (String(code || '').trim() !== x.code) throw new TelegramError('Код не совпадает с кодом, который бот прислал в чат');
    chats[String(chatId)] = {title: x.title, type: x.type, state: 'allowed', approved_at: new Date().toISOString()};
    this.saveChats(chats);
    await this.call('sendMessage', {chat_id: chatId, text: '✅ Чат подключён к SecondBrain. Всё, что пишете или пересылаете сюда, сохраняется в базу. /status — сколько сохранено.'}).catch(() => {});
    return this.status();
  }
  forget(chatId) { const chats = this.chats(); if (!chats[String(chatId)]) throw new TelegramError('Чат не найден'); delete chats[String(chatId)]; this.saveChats(chats); return this.status(); }

  // One long-poll round. timeout=0 for an instant check (button «Обновить», tests).
  async pollOnce({timeout = 0, isEnabled = () => this.connector().enabled} = {}) {
    return this.exclusive(async () => {
      if (!isEnabled()) return {changed: 0, skipped: 'disabled'};
      if (!this.token()) { const e = new TelegramError('Вставьте токен бота в карточке Telegram', {needsLogin: true}); throw e; }
      const offset = this.meta('offset', 0);
      let updates;
      try { updates = await this.call('getUpdates', {offset, timeout, allowed_updates: ALLOWED_UPDATES}, {timeoutMs: (timeout + 15) * 1000}); }
      catch (e) { this.setMeta('last_error', {at: new Date().toISOString(), message: e.message}); throw e; }
      const touched = new Set(); let stored = 0, ignored = 0, nextOffset = offset;
      for (const u of updates) {
        nextOffset = Math.max(nextOffset, u.update_id + 1);
        if (!isEnabled()) break;
        try { const r = await this.handle(u, touched); stored += r.stored || 0; ignored += r.ignored || 0; }
        catch (e) { this.setMeta('last_error', {at: new Date().toISOString(), message: 'Сообщение пропущено: ' + e.message}); }
      }
      let changed = 0;
      for (const key of touched) { const [chat, day] = key.split('|'); if (this.rebuild(chat, day)?.changed) changed++; }
      this.setMeta('offset', nextOffset);
      this.setMeta('last_poll', new Date().toISOString());
      if (updates.length) this.setMeta('last_error', null);
      return {changed, captured: stored, ignored, updates: updates.length};
    });
  }

  async handle(u, touched) {
    if (u.my_chat_member) {
      const {chat, new_chat_member: m} = u.my_chat_member, chats = this.chats(), x = chats[String(chat.id)];
      if (['left', 'kicked'].includes(m.status) && x) { x.state = x.state === 'allowed' ? 'removed' : x.state; this.saveChats(chats); }
      return {};
    }
    const edited = Boolean(u.edited_message || u.edited_channel_post), m = u.message || u.channel_post || u.edited_message || u.edited_channel_post;
    if (!m) return {};
    const chats = this.chats(), id = String(m.chat.id);
    if (m.migrate_to_chat_id) { // group became a supergroup: same people, new id
      if (chats[id]) { chats[String(m.migrate_to_chat_id)] = {...chats[id], type: 'supergroup'}; delete chats[id]; this.saveChats(chats); }
      return {};
    }
    const x = chats[id];
    if (!x || x.state !== 'allowed') {
      if (edited || m.from?.is_bot) return {ignored: 1};
      const now = Math.floor(Date.now() / 1000);
      if (!x || x.state !== 'pending' || x.expires < now) {
        if (Object.values(chats).filter(c => c.state === 'pending' && c.expires > now).length >= 20) return {ignored: 1};
        const code = String(randomInt(100000, 1000000));
        chats[id] = {title: chatName(m.chat), type: m.chat.type, state: 'pending', code, expires: now + 1800};
        this.saveChats(chats);
        await this.call('sendMessage', {chat_id: m.chat.id, text: `Чтобы сохранять сообщения из этого чата в SecondBrain, откройте панель SecondBrain → «Источники» → Telegram и подтвердите код ${code}. Код действует 30 минут. Пока чат не подтверждён, сообщения отсюда не сохраняются.`}).catch(() => {});
      }
      return {ignored: 1};
    }
    if (x.title !== chatName(m.chat)) { x.title = chatName(m.chat); this.saveChats(chats); }
    const text = (m.text || '').trim();
    if (!edited && /^\/(start|status|help)(@\w+)?$/i.test(text)) {
      const today = localDay(Math.floor(Date.now() / 1000)), n = this.store.db.prepare('SELECT count(*) n FROM telegram_messages WHERE chat_id=? AND day=?').get(id, today).n;
      await this.call('sendMessage', {chat_id: m.chat.id, text: `SecondBrain на связи. Сегодня из этого чата сохранено сообщений: ${n}. Пишите или пересылайте сюда — всё попадёт в базу.`}).catch(() => {});
      return {};
    }
    if (isService(m) || m.from?.is_bot && m.from?.id === this.meta('bot', {}).id) return {ignored: 1};
    const files = [];
    const f = fileOf(m);
    if (f && !edited) files.push(await this.download(f));
    const previous = this.store.db.prepare('SELECT payload FROM telegram_messages WHERE chat_id=? AND message_id=?').get(id, m.message_id);
    const keepFiles = previous && edited ? JSON.parse(previous.payload).files || [] : files;
    const author = m.chat.type === 'private' ? 'Вы' : person(m.from) || chatName(m.sender_chat) || chatName(m.chat);
    const line = messageText(m, {files: keepFiles});
    if (!line.trim()) return {ignored: 1};
    const day = localDay(m.date);
    this.store.db.prepare('INSERT INTO telegram_messages VALUES(?,?,?,?,?,?) ON CONFLICT(chat_id,message_id) DO UPDATE SET text=excluded.text,payload=excluded.payload')
      .run(id, m.message_id, day, m.date, line, json({author, files: keepFiles, edited: edited || undefined}));
    touched.add(id + '|' + day);
    return {stored: 1};
  }

  async download(f) {
    if (f.size && f.size > MAX_FILE) return {name: f.name, saved: false, reason: 'больше 20 МБ, Telegram не отдаёт ботам такие файлы — сохраните вручную'};
    try {
      const info = await this.call('getFile', {file_id: f.id});
      if (!info.file_path) return {name: f.name, saved: false, reason: 'Telegram не отдал файл'};
      if (info.file_size && info.file_size > MAX_FILE) return {name: f.name, saved: false, reason: 'больше 20 МБ'};
      const r = await this.fetch(`${this.apiBase}/file/bot${this.token()}/${info.file_path}`, {signal: AbortSignal.timeout(120000)});
      if (!r.ok) return {name: f.name, saved: false, reason: 'ошибка скачивания ' + r.status};
      const bytes = Buffer.from(await r.arrayBuffer()), sha = hash(bytes), root = this.assetDir;
      fs.mkdirSync(root, {recursive: true});
      const target = path.join(root, sha);
      if (!fs.existsSync(target)) fs.writeFileSync(target, bytes, {flag: 'wx'});
      return {name: f.name, saved: true, sha256: sha, mime: f.mime || 'application/octet-stream', bytes: bytes.length, path: target.replaceAll('\\', '/')};
    } catch (e) { return {name: f.name, saved: false, reason: e.message.slice(0, 120)}; }
  }

  // Build (or update) the record "chat × day" from stored message rows.
  rebuild(chatId, day) {
    const rows = this.store.db.prepare('SELECT * FROM telegram_messages WHERE chat_id=? AND day=? ORDER BY date,message_id').all(chatId, day);
    if (!rows.length) return null;
    const chat = this.chats()[chatId] || {title: 'чат ' + chatId, type: 'unknown'}, title = `Telegram · ${chat.title} · ${dayLabel(day)}`;
    const messages = rows.map(r => { const p = JSON.parse(r.payload); return {id: 'm' + r.message_id, role: 'note', text: `[${clock(r.date)}] ${p.author}:\n${r.text}`, time: new Date(r.date * 1000).toISOString()}; });
    const body = `# ${title}\n\n` + messages.map(m => m.text).join('\n\n');
    const receipt = this.store.ingest({provider: 'telegram', external_id: chatId + ':' + day, account: 'personal', kind: 'note', title, body, messages,
      source_date: messages.at(-1).time, date_basis: 'message-date', coverage: {saved_text: true, attachments_saved: rows.reduce((n, r) => n + (JSON.parse(r.payload).files || []).filter(f => f.saved).length, 0)},
      metadata: {connector_id: 'telegram', chat_id: chatId, chat_title: chat.title, chat_type: chat.type, day, messages: rows.length, project_name: 'Telegram · ' + chat.title}}, {transport: 'telegram-bot'});
    for (const r of rows) for (const [index, f] of (JSON.parse(r.payload).files || []).entries()) {
      if (!f.saved) continue;
      this.store.db.prepare('INSERT OR IGNORE INTO assets VALUES(?,?,?,?,?,?,?,?)').run(hash({source: receipt.id, message: r.message_id, index, sha: f.sha256}), receipt.id, f.name, f.path, f.mime, f.bytes, 'saved-unread', json({sha256: f.sha256, storage: 'canonical-assets', service: 'telegram'}));
    }
    return receipt;
  }

  // Telegram Desktop export (result.json): one chat, or «Export all data» with chats.list. Same rows, same records.
  importExport(data) {
    const chatsIn = Array.isArray(data?.chats?.list) ? data.chats.list : data?.messages ? [data] : null;
    if (!chatsIn) throw new TelegramError('Это не выгрузка Telegram Desktop (нет messages)');
    const known = this.chats(), touched = new Set(); let saved = 0, skipped = 0;
    const flat = t => typeof t === 'string' ? t : Array.isArray(t) ? t.map(x => typeof x === 'string' ? x : x?.text || '').join('') : '';
    for (const c of chatsIn) {
      if (!Array.isArray(c.messages)) continue;
      const raw = Number(c.id), type = String(c.type || '');
      const id = String(/supergroup|channel/.test(type) ? '-100' + raw : type === 'private_group' ? -raw : raw);
      const title = c.name || (type === 'saved_messages' ? 'Избранное' : 'чат ' + id);
      if (!known[id]) known[id] = {title, type: type.includes('channel') ? 'channel' : /group/.test(type) ? 'supergroup' : 'private', state: 'imported'};
      for (const m of c.messages) {
        if (m.type !== 'message') { skipped++; continue; }
        const unix = Number(m.date_unixtime) || Math.floor(Date.parse(m.date) / 1000);
        if (!Number.isFinite(unix)) { skipped++; continue; }
        const lines = [];
        if (m.forwarded_from) lines.push('Переслано от: ' + m.forwarded_from);
        const text = flat(m.text);
        if (text) lines.push(text);
        if (m.file || m.photo) lines.push(`[файл: ${path.basename(String(m.file || m.photo))}${m.media_type ? ', ' + m.media_type : ''}]`);
        if (!lines.join('').trim()) { skipped++; continue; }
        const day = localDay(unix);
        this.store.db.prepare('INSERT INTO telegram_messages VALUES(?,?,?,?,?,?) ON CONFLICT(chat_id,message_id) DO NOTHING')
          .run(id, Number(m.id), day, unix, lines.join('\n'), json({author: m.from || title, files: [], imported: true}));
        touched.add(id + '|' + day); saved++;
      }
    }
    this.saveChats(known);
    let changed = 0;
    for (const key of touched) { const [chat, day] = key.split('|'); if (this.rebuild(chat, day)?.changed) changed++; }
    return {messages: saved, skipped, records_changed: changed, days: touched.size};
  }
}

// Registry driver: the «Обновить» button and the 15-minute pass do one instant round; the live loop runs in server.mjs.
export async function collect(store, connector, {isEnabled}) {
  const bot = bots.get(store);
  if (!bot) return {changed: 0, skipped: 'not-started'};
  return bot.pollOnce({timeout: 0, isEnabled});
}

// Live loop: long polling (25 s), backoff on errors, honours Retry-After, stops while disabled.
export function startTelegramLoop(bot, {sleep = ms => new Promise(r => setTimeout(r, ms))} = {}) {
  let stopped = false, delay = 2000;
  (async () => {
    while (!stopped) {
      const c = bot.registry.get('telegram');
      if (!c?.enabled || !bot.token()) { await sleep(5000); continue; }
      try {
        const r = await bot.pollOnce({timeout: 25});
        if (r.updates) bot.store.state('telegram', 'ready', {message: 'Работает', captured: r.captured, driver: 'telegram-bot', live_capture: true, direct_to_db: true});
        delay = 2000;
        // An empty answer normally comes after the 25 s long poll; a proxy that answers at once must not cause a busy loop.
        if (!r.updates) await sleep(1000);
      } catch (e) {
        bot.store.state('telegram', e.needsLogin ? 'needs-login' : 'error', {message: e.message, driver: 'telegram-bot'});
        const wait = e.retryAfter ? e.retryAfter * 1000 : e.needsLogin ? 60000 : delay;
        delay = Math.min(delay * 2, 300000);
        await sleep(wait);
      }
    }
  })();
  return () => { stopped = true; };
}
