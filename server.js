const express = require('express');
const crypto = require('crypto');

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

const PORT = process.env.PORT || 8080;
const API_URL = process.env.ANTHROPIC_API_URL || 'https://api.anthropic.com/v1/messages';
const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';
const MAX_TOKENS = 4000;

// ───────────────────────── configuration ─────────────────────────
const tidy = v => String(v || '').trim().replace(/^["']|["']$/g, '').trim();

const ANTHROPIC_API_KEY = tidy(process.env.ANTHROPIC_API_KEY);

// Login accounts, set in Render as:  APP_USERS = name:password,name2:password2
const USERS = new Map();
String(process.env.APP_USERS || '').split(',').forEach(entry => {
  const e = entry.trim();
  const i = e.indexOf(':');
  if (i > 0 && i < e.length - 1) USERS.set(e.slice(0, i).trim(), e.slice(i + 1));
});

// Signing secret for login cookies. Falls back to a value derived from the API key,
// and to a random one if neither is set (then everyone is logged out on restart).
const SESSION_SECRET = tidy(process.env.SESSION_SECRET) ||
  (ANTHROPIC_API_KEY
    ? crypto.createHash('sha256').update('clearpass-session:' + ANTHROPIC_API_KEY).digest('hex')
    : crypto.randomBytes(32).toString('hex'));

const RATE_PER_HOUR_USER = parseInt(process.env.RATE_LIMIT_PER_HOUR, 10) || 40;
const RATE_PER_HOUR_IP = (parseInt(process.env.RATE_LIMIT_PER_HOUR, 10) || 40) * 2;
const SESSION_DAYS = 7;

const TAG_KEYS = ['client_name', 'budget', 'company', 'contact_info', 'location', 'dates', 'project_name', 'legal', 'personal_details'];
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const MAX_TEXT = 20000;
const MAX_IMAGE_B64 = 7000000; // about 5 MB of image data
const MAX_NOTE = 1000;

// ───────────────────────── helpers ─────────────────────────
function makeLimiter(max, windowMs) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, arr] of hits) { if (!arr.length || now - arr[arr.length - 1] > windowMs) hits.delete(k); }
  }, 10 * 60 * 1000).unref();
  return function take(key) {
    const now = Date.now();
    const arr = (hits.get(key) || []).filter(t => now - t < windowMs);
    if (arr.length >= max) {
      hits.set(key, arr);
      return { ok: false, retryAfter: Math.max(1, Math.ceil((windowMs - (now - arr[0])) / 1000)) };
    }
    arr.push(now);
    hits.set(key, arr);
    return { ok: true };
  };
}
const loginLimit = makeLimiter(10, 15 * 60 * 1000);
const userLimit = makeLimiter(RATE_PER_HOUR_USER, 60 * 60 * 1000);
const ipLimit = makeLimiter(RATE_PER_HOUR_IP, 60 * 60 * 1000);

const sha = s => crypto.createHash('sha256').update(String(s)).digest();
function safeEqual(a, b) { return crypto.timingSafeEqual(sha(a), sha(b)); }

function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  return body + '.' + mac;
}
function verify(token) {
  if (!token || token.indexOf('.') < 0) return null;
  const [body, mac] = token.split('.');
  const expect = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  if (!mac || mac.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expect))) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (!p.u || !p.exp || Date.now() > p.exp) return null;
    return p;
  } catch { return null; }
}
function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return '';
}
function setSession(req, res, user) {
  const token = sign({ u: user, exp: Date.now() + SESSION_DAYS * 86400000 });
  res.setHeader('Set-Cookie', `cp_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}${req.secure ? '; Secure' : ''}`);
}
function clearSession(req, res) {
  res.setHeader('Set-Cookie', `cp_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${req.secure ? '; Secure' : ''}`);
}
function fail(res, status, message, extra) { return res.status(status).json({ error: { message }, ...(extra || {}) }); }

function requireAuth(req, res, next) {
  const p = verify(readCookie(req, 'cp_session'));
  if (!p || !USERS.has(p.u)) return fail(res, 401, 'Please sign in.');
  req.user = p.u;
  next();
}

// ───────────────────────── prompts (kept on the server) ─────────────────────────
const SYSTEM = 'You are a confidential message declassification agent. Strip sensitive business information from client messages before sharing with technical employees. Return ONLY valid JSON. No markdown fences. No extra text.';

const BRIEF_RULES = `You are preparing a task brief for a freelancer who works for an agency. The freelancer must NOT be able to work out who the end client is, and must not be able to find the original job on Upwork.
REMOVE completely: client name, company/brand/product name, the exact job title, the client's budget, rates and payment terms, links, URLs, usernames and emails, and the client's country, city and time zone.
ALSO REMOVE or generalize indirect clues that could be searched for: combinations such as industry + city + company size + funding stage, distinctive product descriptions, named competitors, named integrations that only this client uses, and unusual deadlines tied to a public event. Replace these with generic wording (for example "a B2B SaaS product" or "an early-stage startup").
KEEP everything the freelancer needs to do the work: the actual tasks, deliverables, technologies and versions, platforms, functional requirements, acceptance criteria and general priorities. Keep the location of the work itself when the freelancer must be there or work in that region.
Do not invent requirements. If something important is missing, list it under questions for the client.`;

const BRIEF_SCHEMA = `Return ONLY this JSON (no markdown):
{
  "clean_message": "the finished brief as plain text, ready to paste into a chat. RULES: (1) Do NOT write a title or heading line. Begin directly with the word Overview. (2) Use these section headers, each followed by its content, with a blank line between sections and '- ' for bullets: Overview, Scope of work, Tech and skills. (3) Write the Overview in a neutral, impersonal voice that says what work is needed, for example 'Engineer needed to support electronics production at factories in China, from process setup through to mass production quality control.' Never say that a company, startup, client or team is looking for or hiring someone, and never use we, our, or the client. (4) Add a Deliverables or Acceptance criteria section ONLY if the source text states them. Otherwise leave those sections out completely. (5) Never invent anything that is not in the source: no timelines, sign-off terms, rates, tools or cultural notes. Stay faithful to the source wording. (6) Do not include any questions in this text. No markdown symbols and no client identifying details.",
  "redacted_items": [{"category": "client_name|company|budget|job_title|links|location|indirect_clue|other", "original": "the exact text removed or generalized", "token": "[REDACTED: CATEGORY]"}],
  "summary_for_team": "one sentence describing the task with zero identifying details",
  "residual_risks": ["short notes on anything left in the brief that could still help someone identify the client, for example a very specific product feature. Use an empty array if you see none."],
  "questions_for_client": ["important details missing from the source that the user should ask their own client before assigning the work, for example the expected weekly time commitment or the product types in scope. Use an empty array if nothing important is missing."],
  "sensitivity_level": "low|medium|high",
  "redact_count": 3
}`;

const MSG_SCHEMA_TEXT = `Return ONLY this JSON (no markdown):
{
  "declassified_message": "full message with sensitive parts replaced by [REDACTED: CATEGORY] tokens",
  "clean_message": "same message but completely remove every [REDACTED: CATEGORY] token and any surrounding punctuation or words that no longer make sense without it, so the message reads naturally and fluently with nothing missing or awkward. For example 'Hey [REDACTED: CLIENT_NAME],' becomes just 'Hey,' and 'budget is [REDACTED: BUDGET]' becomes just remove that clause entirely.",
  "redacted_items": [{"category": "client_name|budget|etc", "original": "actual text found", "token": "[REDACTED: CATEGORY]"}],
  "summary_for_team": "1-2 sentence plain task summary with zero sensitive information",
  "sensitivity_level": "low|medium|high",
  "redact_count": 3
}`;

const MSG_SCHEMA_IMAGE = `Return ONLY this JSON (no markdown):
{
  "extracted_text": "all text from the image verbatim",
  "declassified_message": "same text but sensitive parts replaced by [REDACTED: CATEGORY] tokens",
  "clean_message": "same message but completely remove every [REDACTED: CATEGORY] token and any surrounding punctuation or words that no longer make sense without it, so the message reads naturally and fluently. For example 'Hey [REDACTED: CLIENT_NAME],' becomes just 'Hey,' and 'budget is [REDACTED: BUDGET]' becomes remove that clause entirely.",
  "redacted_items": [{"category": "client_name|budget|etc", "original": "actual text", "token": "[REDACTED: CATEGORY]"}],
  "summary_for_team": "1-2 sentence plain task summary with zero sensitive information",
  "sensitivity_level": "low|medium|high",
  "redact_count": 3
}`;

function buildPrompt({ mode, text, hasImage, tags, custom, context }) {
  if (mode === 'brief') {
    const head = hasImage
      ? 'Read all the text in this screenshot of an Upwork job post, then turn it into a freelancer brief.\n'
      : '';
    const body = hasImage ? '' : `\n\nUpwork job post:\n"""\n${text}\n"""`;
    return `${head}${BRIEF_RULES}${custom ? '\nAlso remove: ' + custom : ''}
${context ? 'Context about the freelancer or team: ' + context : ''}${body}

${BRIEF_SCHEMA}`;
  }
  if (hasImage) {
    return `Read all text in this image then declassify it. Redact: ${tags.join(', ')}${custom ? '\nAlso redact: ' + custom : ''}.
${context ? 'Team context: ' + context : ''}

${MSG_SCHEMA_IMAGE}`;
  }
  return `Declassify this client message. Redact: ${tags.join(', ')}${custom ? '\nAlso redact: ' + custom : ''}.
${context ? 'Team context: ' + context : ''}

Client message:
"""
${text}
"""

${MSG_SCHEMA_TEXT}`;
}

function parseModelJson(raw) {
  let t = String(raw || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  try { return JSON.parse(t); } catch { /* fall through */ }
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch { /* fall through */ } }
  return null;
}

const strs = v => (Array.isArray(v) ? v.map(x => String(x == null ? '' : x).trim()).filter(Boolean) : []);
function normalise(o) {
  const level = ['low', 'medium', 'high'].includes(o.sensitivity_level) ? o.sensitivity_level : 'medium';
  const items = (Array.isArray(o.redacted_items) ? o.redacted_items : []).map(r => ({
    category: String((r && r.category) || ''), original: String((r && r.original) || ''), token: String((r && r.token) || '[REDACTED]'),
  }));
  const out = {
    clean_message: String(o.clean_message || ''),
    redacted_items: items,
    summary_for_team: String(o.summary_for_team || ''),
    residual_risks: strs(o.residual_risks),
    questions_for_client: strs(o.questions_for_client),
    sensitivity_level: level,
    redact_count: items.length,
  };
  if (o.declassified_message) out.declassified_message = String(o.declassified_message);
  if (o.extracted_text) out.extracted_text = String(o.extracted_text);
  return out;
}

async function callClaude(content) {
  return fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODEL, max_tokens: MAX_TOKENS, system: SYSTEM, messages: [{ role: 'user', content }] }),
    signal: AbortSignal.timeout(110000),
  });
}

// ───────────────────────── middleware ─────────────────────────
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
  next();
});

// ───────────────────────── routes ─────────────────────────
app.post('/api/login', express.json({ limit: '4kb' }), (req, res) => {
  const lim = loginLimit(req.ip);
  if (!lim.ok) return fail(res, 429, `Too many sign-in attempts. Try again in ${Math.ceil(lim.retryAfter / 60)} minutes.`);
  if (USERS.size === 0) return fail(res, 503, 'Sign-in is not set up on the server yet. Add APP_USERS in the server settings.');
  const u = String((req.body && req.body.username) || '').trim();
  const p = String((req.body && req.body.password) || '');
  let ok = false;
  if (USERS.has(u)) ok = safeEqual(USERS.get(u), p);
  else safeEqual('x', p); // keep timing similar for unknown users
  if (!ok) return fail(res, 401, 'Incorrect username or password.');
  setSession(req, res, u);
  res.json({ user: u });
});

app.post('/api/logout', (req, res) => { clearSession(req, res); res.json({ ok: true }); });

app.get('/api/me', requireAuth, (req, res) => res.json({ user: req.user }));

app.get('/api/health', requireAuth, async (req, res) => {
  const info = { node: process.version, model: MODEL, keyPresent: ANTHROPIC_API_KEY.length > 0, usersConfigured: USERS.size, perHourLimit: RATE_PER_HOUR_USER };
  if (req.query.test !== '1') return res.json({ ok: info.keyPresent, ...info, hint: 'Add ?test=1 to also test the AI connection.' });
  if (!info.keyPresent) return res.json({ ok: false, problem: 'ANTHROPIC_API_KEY is not set on the server', ...info });
  try {
    const r = await fetch(API_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model: MODEL, max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] }), signal: AbortSignal.timeout(30000) });
    const data = await r.json();
    if (!r.ok) return res.json({ ok: false, problem: 'Anthropic rejected the request', anthropicStatus: r.status, anthropicError: data.error || data, ...info });
    return res.json({ ok: true, message: 'The AI connection works', ...info });
  } catch (err) {
    return res.json({ ok: false, problem: 'Server could not reach Anthropic', detail: String(err && err.message), ...info });
  }
});

app.post('/api/declassify', requireAuth, express.json({ limit: '8mb' }), async (req, res) => {
  if (!ANTHROPIC_API_KEY) return fail(res, 500, 'ANTHROPIC_API_KEY is not set on the server');

  const b = req.body || {};
  const mode = b.mode;
  if (mode !== 'msg' && mode !== 'brief') return fail(res, 400, 'Unknown mode.');

  const text = typeof b.text === 'string' ? b.text.trim() : '';
  const img = b.image && typeof b.image === 'object' ? b.image : null;
  if ((text ? 1 : 0) + (img ? 1 : 0) !== 1) return fail(res, 400, 'Send either text or an image.');
  if (text.length > MAX_TEXT) return fail(res, 400, `Text is too long. The limit is ${MAX_TEXT.toLocaleString()} characters.`);
  if (img) {
    if (!IMAGE_TYPES.includes(img.media_type)) return fail(res, 400, 'Unsupported image type. Use PNG, JPG, WEBP or GIF.');
    if (typeof img.data !== 'string' || !img.data || img.data.length > MAX_IMAGE_B64 || /[^A-Za-z0-9+/=\s]/.test(img.data.slice(0, 2000))) return fail(res, 400, 'Image is missing, invalid or larger than 5 MB.');
  }

  const tags = Array.isArray(b.tags) ? b.tags.filter(t => TAG_KEYS.includes(t)) : [];
  if (mode === 'msg' && tags.length === 0) return fail(res, 400, 'Select at least one thing to redact.');
  const custom = typeof b.custom === 'string' ? b.custom.trim().slice(0, MAX_NOTE) : '';
  const context = typeof b.context === 'string' ? b.context.trim().slice(0, MAX_NOTE) : '';

  const u = userLimit(req.user);
  if (!u.ok) return fail(res, 429, `Hourly limit reached. You can run more in ${Math.ceil(u.retryAfter / 60)} minutes.`);
  const ip = ipLimit(req.ip);
  if (!ip.ok) return fail(res, 429, 'Too many requests from this network. Please wait and try again.');

  const prompt = buildPrompt({ mode, text, hasImage: !!img, tags, custom, context });
  const content = img
    ? [{ type: 'image', source: { type: 'base64', media_type: img.media_type, data: img.data.replace(/\s/g, '') } }, { type: 'text', text: prompt }]
    : [{ type: 'text', text: prompt }];

  try {
    const r = await callClaude(content);
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      console.error('Anthropic error', r.status, JSON.stringify(data));
      if (r.status === 429 || r.status === 529) return fail(res, 503, 'The AI service is busy. Please try again in a moment.');
      const why = (data && data.error && data.error.message) || 'unknown error';
      return fail(res, 502, `AI service error (${r.status}): ${why}`);
    }
    if (data.stop_reason === 'max_tokens') return fail(res, 502, 'The reply was cut off because the input is very long. Try a shorter text.');
    const raw = (data.content || []).map(c => c.text || '').join('');
    const parsed = parseModelJson(raw);
    if (!parsed || typeof parsed !== 'object') {
      console.error('Unreadable AI reply:', raw.slice(0, 300));
      return fail(res, 502, 'The AI reply could not be read. Please try again.');
    }
    return res.json({ result: normalise(parsed) });
  } catch (err) {
    console.error('Proxy error:', err);
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return fail(res, timedOut ? 504 : 502, timedOut ? 'The AI took too long to answer. Please try again.' : 'Could not reach the AI service: ' + (err && err.message));
  }
});

app.use(express.static('public'));

// JSON errors (bad JSON, body too large) instead of HTML pages
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err && err.type === 'entity.too.large') return fail(res, 413, 'That upload is too large.');
  if (err && err.type === 'entity.parse.failed') return fail(res, 400, 'Malformed request.');
  console.error(err);
  return fail(res, 500, 'Server error.');
});

app.listen(PORT, () => {
  console.log(`ClearPass server running on port ${PORT}`);
  if (!ANTHROPIC_API_KEY) console.warn('WARNING: ANTHROPIC_API_KEY is not set');
  if (USERS.size === 0) console.warn('WARNING: APP_USERS is not set, so nobody can sign in');
});
