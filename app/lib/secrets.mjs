// Deterministic secret masking for everything that leaves the database: Luna packets, API and MCP responses.
// Stored originals are not rewritten. Only well-known credential shapes and explicit "name = value" assignments
// are masked; hashes, UUIDs and ordinary text are left alone. Patterns never consume quotes or backslashes, so
// masking an already serialized JSON string keeps it valid JSON.
const RULES = [
  ['приватный ключ', /-----BEGIN [A-Z ]*PRIVATE KEY-----[^"]*?-----END [A-Z ]*PRIVATE KEY-----/g],
  ['ключ Anthropic', /\bsk-ant-[A-Za-z0-9_-]{20,}/g],
  ['ключ OpenAI', /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g],
  ['токен GitHub', /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{40,}/g],
  ['ключ AWS', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ['ключ Google', /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ['токен Slack', /\bxox[abprs]-[A-Za-z0-9-]{10,}/g],
  ['токен Яндекса', /\by[0-3]_[A-Za-z0-9_-]{30,}/g],
  ['токен Telegram', /\b\d{8,10}:AA[A-Za-z0-9_-]{30,}\b/g],
  ['JWT', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g],
  ['Bearer-токен', /\b(Bearer)\s+(?!\[)[A-Za-z0-9._~+/=-]{20,}/g],
];
const ASSIGN = /(?<![\p{L}\p{N}_])(api[_-]?key|apikey|secret|client[_-]?secret|access[_-]?token|auth[_-]?token|token|password|passwd|пароль)(\s*[:=]\s*)(?!\[скрыто)(?=[^\s"'\\,;<>]*[0-9_\-!@#$%^&*])([^\s"'\\,;<>]{8,})/giu;

// Encoded attachments and inline images (base64) are noise for people and models (2026-11-19: e-mails whose text
// was mostly base64 could not be carded). Not secrets, so not counted. Real lines of text always contain spaces or
// punctuation that base64 does not, so ordinary prose, hashes and keys are untouched.
const DATA_URI = /data:[\w.+\/-]{1,80};base64,[A-Za-z0-9+\/=]{80,}/g;
const B64_BLOCK = /(?:[A-Za-z0-9+\/]{40,}={0,2}[ \t]*\r?\n){3,}[A-Za-z0-9+\/]*={0,2}|[A-Za-z0-9+\/]{400,}={0,2}/g;
export function hideBinary(text) {
  return text.replace(DATA_URI, '[скрыто: двоичные данные]').replace(B64_BLOCK, m => m.length >= 200 ? '[скрыто: двоичные данные]' + (/\n$/.test(m) ? '\n' : '') : m);
}
export function maskSecrets(input) {
  if (typeof input !== 'string' || !input) return { text: input, count: 0 };
  let count = 0, text = input;
  for (const [kind, re] of RULES) {
    text = text.replace(re, (m, g1) => { count++; return kind === 'Bearer-токен' ? `${g1} [скрыто: токен]` : `[скрыто: ${kind}]`; });
  }
  text = text.replace(ASSIGN, (m, name, sep) => { count++; return `${name}${sep}[скрыто]`; });
  text = hideBinary(text);
  return { text, count };
}
export const mask = s => maskSecrets(s).text;
