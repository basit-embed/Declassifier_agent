const express = require('express');
const crypto = require('crypto');

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

const PORT = process.env.PORT || 8080;
const API_URL = process.env.ANTHROPIC_API_URL || 'https://api.anthropic.com/v1/messages';
const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';
const MAX_TOKENS = parseInt(process.env.MAX_TOKENS, 10) || 9000;

// ───────────────────────── configuration ─────────────────────────
const tidy = v => String(v || '').trim().replace(/^["']|["']$/g, '').trim();

const ANTHROPIC_API_KEY = tidy(process.env.ANTHROPIC_API_KEY);

// Supabase (public values only; no secret keys are needed)
const SB_URL = (() => {
  const raw = tidy(process.env.SUPABASE_URL);
  if (!raw) return '';
  try { return new URL(/^https?:\/\//i.test(raw) ? raw : 'https://' + raw).origin; } catch { return raw.replace(/\/+$/, ''); }
})();
const SB_KEY = tidy(process.env.SUPABASE_ANON_KEY);
const SB_ON = !!(SB_URL && SB_KEY);

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
const MAX_TEXT = 12000;
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

const isUuid = v => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const tokenCache = new Map();

async function sb(path, token, opts = {}) {
  const r = await fetch(SB_URL + path, {
    method: opts.method || 'GET',
    headers: { apikey: SB_KEY, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', ...(opts.prefer ? { Prefer: opts.prefer } : {}) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    signal: AbortSignal.timeout(20000),
  });
  const text = await r.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch { /* ignore */ }
  return { ok: r.ok, status: r.status, data };
}
const sbMsg = (r, dflt) => (r.data && (r.data.message || r.data.msg || r.data.error_description)) || dflt;

async function requireAuth(req, res, next) {
  if (SB_ON) {
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
    if (!m) return fail(res, 401, 'Please sign in.');
    const tok = m[1].trim();
    const hit = tokenCache.get(tok);
    if (hit && hit.exp > Date.now()) { req.user = hit.id; req.email = hit.email; req.token = tok; return next(); }
    try {
      const r = await fetch(SB_URL + '/auth/v1/user', { headers: { apikey: SB_KEY, Authorization: 'Bearer ' + tok }, signal: AbortSignal.timeout(15000) });
      if (r.ok) {
        const u = await r.json();
        if (u && isUuid(u.id)) {
          if (tokenCache.size > 500) tokenCache.clear();
          tokenCache.set(tok, { id: u.id, email: u.email || '', exp: Date.now() + 60000 });
          req.user = u.id; req.email = u.email || ''; req.token = tok;
          return next();
        }
      }
    } catch (e) { return fail(res, 503, 'Could not reach the sign-in service. Try again in a moment.'); }
    return fail(res, 401, 'Please sign in.');
  }
  const p = verify(readCookie(req, 'cp_session'));
  if (!p || !USERS.has(p.u)) return fail(res, 401, 'Please sign in.');
  req.user = p.u;
  next();
}

// Team data, read with the user's own token (Supabase row-level security decides what is visible)
async function loadTeam(token, uid, full) {
  const m = await sb(`/rest/v1/members?select=role,team:teams(id,name,rules)&user_id=eq.${uid}&limit=1`, token);
  if (!m.ok) throw new Error(sbMsg(m, 'Could not load your team'));
  const row = m.data && m.data[0];
  if (!row || !row.team) return null;
  const t = { id: row.team.id, name: row.team.name, rules: row.team.rules || '', role: row.role };
  if (!full) return t;
  const [cl, mem, sec] = await Promise.all([
    sb(`/rest/v1/clients?select=id,label,terms&team_id=eq.${t.id}&order=created_at.asc`, token),
    sb(`/rest/v1/members?select=user_id,email,role&team_id=eq.${t.id}&order=created_at.asc`, token),
    t.role === 'owner' ? sb(`/rest/v1/team_secrets?select=invite_code&team_id=eq.${t.id}`, token) : Promise.resolve(null),
  ]);
  t.clients = cl.ok ? cl.data : [];
  t.members = mem.ok ? mem.data : [];
  if (sec && sec.ok && sec.data && sec.data[0]) t.inviteCode = sec.data[0].invite_code;
  return t;
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

const POACH_RULES = `
ANTI-POACHING MODE. The reader must not be able to find or contact this client directly. Also remove or generalize: the names of platforms and marketplaces (Upwork, Fiverr, LinkedIn and similar), job, contract, proposal and invoice IDs, profile names and handles, links of any kind, hourly rates and payment terms, and any distinctive phrase, product description, slogan or unusual detail that could be typed into a search engine to find the client. Also generalize combinations such as industry + city + company size. Keep the task itself fully usable.`;

function termsLine(terms) {
  return terms.length ? '\nKNOWN CLIENT DETAILS. Always remove every one of these, in any spelling, case, abbreviation or possessive form, and anything that clearly refers to them: ' + terms.map(t => JSON.stringify(t)).join(', ') + '.' : '';
}

const REPLY_RULES = `You are helping the owner of an agency write to their client. The agency has handed the work to a subcontractor. The client must never learn that a subcontractor, freelancer, Upwork contact or outside team exists.
Below is a message from the subcontractor. Write the message the agency owner should send to the client, in the first person plural ("we", "our team"), as if the agency's own team did the work.
RULES: (1) Never mention a freelancer, subcontractor, contractor, outsourcing or the subcontractor's name, location or platform. (2) Keep every fact, number, date and technical detail that the client needs, and invent nothing: no promises, deadlines, prices or results that are not in the subcontractor's message. (3) Turn the subcontractor's questions into clear questions for the client. (4) Turn a status update into a short, confident progress update. (5) Match the requested tone. (6) Plain text only, no markdown, no subject line, no sign-off name. (7) Keep it short and natural, like a real message between professionals.`;

function rulesLine(rules) {
  return rules ? '\nCOMPANY RULES set by the account owner. Always follow these in addition to everything above: ' + rules : '';
}

const PLAN_PERSONA = {
  software: 'You are a senior software and web delivery lead with 15 years of experience shipping products. Plan around discovery, architecture, design, build in iterations, testing, deployment and handover.',
  hardware: 'You are a senior hardware product engineer and program manager who has taken many electronics products from idea to production. Plan around requirements, architecture, component and supplier selection (bill of materials, lead times), schematic and PCB design, firmware, prototype builds, test and validation stages, certification (such as CE, FCC, UL, RoHS where relevant), tooling, pilot run and production handover, and call out long-lead items and supply risks.',
};
function planPrompt({ text, persona, audience, terms, rules, custom, context }) {
  const team = audience === 'team';
  return `${PLAN_PERSONA[persona] || PLAN_PERSONA.software}
Write a development plan for the project described in the client's requirements below.
STYLE: plain, human and practical, as an experienced person would write it for a colleague. No hype, no filler, no AI-sounding phrases. Use short paragraphs and simple bullet points.
CONTENT: ${persona === 'hardware' ? 'Phases with goals, deliverables and what must be true to move on; a timeline in weeks; roles needed; key components or long-lead items; risks and how to reduce them; assumptions and open questions.' : 'Phases with goals and deliverables; a timeline in weeks; roles needed; tech approach; risks and how to reduce them; assumptions and open questions.'} Give effort and timeline only as ranges in weeks or person-days. NEVER give prices, costs, rates, budgets or any money amounts, and do not repeat any budget mentioned in the requirements. Do not invent facts the requirements do not state; put gaps under "Open questions".
${team ? 'AUDIENCE: the internal or outsourced delivery team. They must not learn who the client is. Never use the client name, company name, product or brand names, contact details, locations or any identifying detail; refer to "the client". Generalise anything that could identify them.' : 'AUDIENCE: the client. Address them directly and keep a confident, professional tone. You may use their project details, but still no prices or money amounts.'}${termsLine(terms)}${rulesLine(rules)}${custom ? '\nAlso: ' + custom : ''}
${context ? 'Extra instructions: ' + context : ''}
FORMAT: plain text only. Start each section with a line beginning "## " (for example "## Overview", "## Phases", "## Timeline", "## Team", "## Risks", "## Open questions"). Use "- " for bullets. No other markdown, no bold, no tables.

Client requirements:
"""
${text}
"""

Return ONLY this JSON (no markdown): { "clean_message": "the full plan as plain text" }`;
}

function buildPrompt({ mode, text, hasImage, tags, custom, context, terms, clientName, tone, strict, rules, persona, audience }) {
  if (mode === 'plan') return planPrompt({ text, persona, audience, terms, rules, custom, context });
  if (mode === 'reply') {
    return `${REPLY_RULES}
Tone: ${tone}.
${clientName ? 'Start with a greeting using this name: ' + clientName : 'Start with a simple greeting without a name.'}
${context ? 'Extra instructions from the agency owner: ' + context : ''}

Subcontractor's message:
"""
${text}
"""

Return ONLY this JSON (no markdown):
{ "clean_message": "the message to send to the client" }`;
  }
  if (mode === 'brief') {
    const head = hasImage
      ? 'Read all the text in this screenshot of an Upwork job post, then turn it into a freelancer brief.\n'
      : '';
    const body = hasImage ? '' : `\n\nUpwork job post:\n"""\n${text}\n"""`;
    return `${head}${BRIEF_RULES}${termsLine(terms)}${rulesLine(rules)}${custom ? '\nAlso remove: ' + custom : ''}
${context ? 'Context about the freelancer or team: ' + context : ''}${body}

${BRIEF_SCHEMA}`;
  }
  if (hasImage) {
    return `Read all text in this attached image or document then declassify it. Redact: ${tags.join(', ')}${strict ? POACH_RULES : ''}${termsLine(terms)}${rulesLine(rules)}${custom ? '\nAlso redact: ' + custom : ''}.
${context ? 'Team context: ' + context : ''}

${MSG_SCHEMA_IMAGE}`;
  }
  const long = text.length > 3000;
  const schema = long ? MSG_SCHEMA_TEXT.replace(/\n  "declassified_message": [^\n]*/, '') : MSG_SCHEMA_TEXT;
  return `Declassify this client message. Redact: ${tags.join(', ')}${strict ? POACH_RULES : ''}${termsLine(terms)}${rulesLine(rules)}${custom ? '\nAlso redact: ' + custom : ''}.
${context ? 'Team context: ' + context : ''}

Client message:
"""
${text}
"""

${schema}`;
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

// Safety net: remove any saved client term the AI left in the text meant for the freelancer.
const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function scrubTerms(result, terms) {
  const hit = [];
  for (const t of [...terms].sort((a, b) => b.length - a.length)) {
    const re = new RegExp('(?<![\\p{L}\\p{N}])' + escRe(t).replace(/\s+/g, '\\s+') + "(?:['\u2019]s?)?(?![\\p{L}\\p{N}])", 'giu');
    let found = false;
    for (const k of ['clean_message', 'summary_for_team']) {
      if (re.test(result[k])) { found = true; re.lastIndex = 0; result[k] = result[k].replace(re, '').replace(/[ \t]{2,}/g, ' ').replace(/ +([,.;:!?])/g, '$1'); }
      re.lastIndex = 0;
    }
    if (found) hit.push(t);
  }
  return hit;
}

async function callClaude(content) {
  return fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODEL, max_tokens: MAX_TOKENS, system: SYSTEM, messages: [{ role: 'user', content }] }),
    signal: AbortSignal.timeout(150000),
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
app.get('/api/config', (req, res) => res.json(SB_ON ? { mode: 'supabase', supabaseUrl: SB_URL, supabaseAnonKey: SB_KEY } : { mode: 'legacy' }));

function teamRoutes() {
  const json = express.json({ limit: '32kb' });
  const wrap = fn => async (req, res) => { try { await fn(req, res); } catch (e) { console.error(e); fail(res, 502, 'Something went wrong talking to the database.'); } };
  const need = (req, res) => { if (!SB_ON) { fail(res, 404, 'Teams are not enabled.'); return false; } return true; };

  app.get('/api/team', requireAuth, wrap(async (req, res) => {
    if (!need(req, res)) return;
    res.json({ user: { id: req.user, email: req.email }, team: await loadTeam(req.token, req.user, true) });
  }));
  app.post('/api/team/create', requireAuth, json, wrap(async (req, res) => {
    if (!need(req, res)) return;
    const name = String((req.body && req.body.name) || '').trim().slice(0, 80);
    if (!name) return fail(res, 400, 'Give your team a name.');
    const r = await sb('/rest/v1/rpc/create_team', req.token, { method: 'POST', body: { team_name: name } });
    if (!r.ok) return fail(res, 400, sbMsg(r, 'Could not create the team.'));
    res.json({ ok: true });
  }));
  app.post('/api/team/join', requireAuth, json, wrap(async (req, res) => {
    if (!need(req, res)) return;
    const code = String((req.body && req.body.code) || '').trim().slice(0, 40);
    if (!code) return fail(res, 400, 'Enter the invite code.');
    const r = await sb('/rest/v1/rpc/join_team', req.token, { method: 'POST', body: { code } });
    if (!r.ok) return fail(res, 400, sbMsg(r, 'That invite code did not work.'));
    res.json({ ok: true });
  }));
  app.post('/api/team/rules', requireAuth, json, wrap(async (req, res) => {
    if (!need(req, res)) return;
    const t = await loadTeam(req.token, req.user, false);
    if (!t || t.role !== 'owner') return fail(res, 403, 'Only the team owner can change company rules.');
    const rules = String((req.body && req.body.rules) || '').slice(0, 2000);
    const r = await sb(`/rest/v1/teams?id=eq.${t.id}`, req.token, { method: 'PATCH', body: { rules }, prefer: 'return=minimal' });
    if (!r.ok) return fail(res, 400, sbMsg(r, 'Could not save the rules.'));
    res.json({ ok: true });
  }));
  app.get('/api/team/activity', requireAuth, wrap(async (req, res) => {
    if (!need(req, res)) return;
    const t = await loadTeam(req.token, req.user, false);
    if (!t || t.role !== 'owner') return fail(res, 403, 'Only the team owner can see activity.');
    const r = await sb(`/rest/v1/activity?select=email,mode,client_label,redacted,created_at&team_id=eq.${t.id}&order=created_at.desc&limit=100`, req.token);
    if (!r.ok) return fail(res, 400, sbMsg(r, 'Could not load activity. Did you run the activity SQL?'));
    res.json({ activity: r.data || [] });
  }));
  app.post('/api/team/invite-code', requireAuth, wrap(async (req, res) => {
    if (!need(req, res)) return;
    const t = await loadTeam(req.token, req.user, false);
    if (!t || t.role !== 'owner') return fail(res, 403, 'Only the team owner can do that.');
    const r = await sb('/rest/v1/rpc/new_invite_code', req.token, { method: 'POST', body: { tid: t.id } });
    if (!r.ok) return fail(res, 400, sbMsg(r, 'Could not make a new code.'));
    res.json({ inviteCode: r.data });
  }));
  app.delete('/api/team/members/:uid', requireAuth, wrap(async (req, res) => {
    if (!need(req, res)) return;
    if (!isUuid(req.params.uid)) return fail(res, 400, 'Bad request.');
    const t = await loadTeam(req.token, req.user, false);
    if (!t || t.role !== 'owner') return fail(res, 403, 'Only the team owner can remove members.');
    const r = await sb(`/rest/v1/members?team_id=eq.${t.id}&user_id=eq.${req.params.uid}&role=eq.member`, req.token, { method: 'DELETE', prefer: 'return=minimal' });
    if (!r.ok) return fail(res, 400, sbMsg(r, 'Could not remove that member.'));
    res.json({ ok: true });
  }));


  // ── projects: saved, cleaned results (never original messages) ──
  const PKINDS = ['msg', 'brief', 'reply', 'plan'];
  const cleanName = v => String(v || '').trim().slice(0, 80);
  const optUuid = v => (typeof v === 'string' && isUuid(v)) ? v : null;
  app.get('/api/projects', requireAuth, wrap(async (req, res) => {
    if (!need(req, res)) return;
    const t = await loadTeam(req.token, req.user, false); if (!t) return fail(res, 403, 'Create or join a team first.');
    const r = await sb(`/rest/v1/projects?select=id,name,client_id,created_by,created_at&team_id=eq.${t.id}&order=created_at.desc&limit=200`, req.token);
    if (!r.ok) return fail(res, 400, sbMsg(r, 'Could not load projects. Did you run the projects SQL?'));
    res.json({ projects: r.data || [] });
  }));
  app.post('/api/projects', requireAuth, json, wrap(async (req, res) => {
    if (!need(req, res)) return;
    const t = await loadTeam(req.token, req.user, false); if (!t) return fail(res, 403, 'Create or join a team first.');
    const name = cleanName(req.body && req.body.name); if (!name) return fail(res, 400, 'Give the project a name.');
    const r = await sb('/rest/v1/projects', req.token, { method: 'POST', body: { team_id: t.id, name, client_id: optUuid(req.body && req.body.clientId), created_by: req.user }, prefer: 'return=representation' });
    if (!r.ok) return fail(res, 400, sbMsg(r, 'Could not create the project.'));
    res.json({ project: Array.isArray(r.data) ? r.data[0] : r.data });
  }));
  app.patch('/api/projects/:id', requireAuth, json, wrap(async (req, res) => {
    if (!need(req, res)) return;
    if (!isUuid(req.params.id)) return fail(res, 400, 'Bad request.');
    const body = {}; const b = req.body || {};
    if ('name' in b) { body.name = cleanName(b.name); if (!body.name) return fail(res, 400, 'Give the project a name.'); }
    if ('clientId' in b) body.client_id = optUuid(b.clientId);
    if (!Object.keys(body).length) return fail(res, 400, 'Nothing to change.');
    const r = await sb(`/rest/v1/projects?id=eq.${req.params.id}`, req.token, { method: 'PATCH', body, prefer: 'return=representation' });
    if (!r.ok) return fail(res, 400, sbMsg(r, 'Could not update the project.'));
    if (!r.data || !r.data[0]) return fail(res, 403, 'Only the team owner or the project creator can change it.');
    res.json({ project: r.data[0] });
  }));
  app.delete('/api/projects/:id', requireAuth, wrap(async (req, res) => {
    if (!need(req, res)) return;
    if (!isUuid(req.params.id)) return fail(res, 400, 'Bad request.');
    const r = await sb(`/rest/v1/projects?id=eq.${req.params.id}`, req.token, { method: 'DELETE', prefer: 'return=representation' });
    if (!r.ok) return fail(res, 400, sbMsg(r, 'Could not delete the project.'));
    if (!r.data || !r.data[0]) return fail(res, 403, 'Only the team owner or the project creator can delete it.');
    res.json({ ok: true });
  }));
  app.get('/api/projects/:id/items', requireAuth, wrap(async (req, res) => {
    if (!need(req, res)) return;
    if (!isUuid(req.params.id)) return fail(res, 400, 'Bad request.');
    const r = await sb(`/rest/v1/project_items?select=id,kind,title,content,meta,email,created_by,created_at&project_id=eq.${req.params.id}&order=created_at.desc&limit=200`, req.token);
    if (!r.ok) return fail(res, 400, sbMsg(r, 'Could not load this project.'));
    res.json({ items: r.data || [] });
  }));
  app.post('/api/projects/:id/items', requireAuth, express.json({ limit: '200kb' }), wrap(async (req, res) => {
    if (!need(req, res)) return;
    if (!isUuid(req.params.id)) return fail(res, 400, 'Bad request.');
    const t = await loadTeam(req.token, req.user, false); if (!t) return fail(res, 403, 'Create or join a team first.');
    const b = req.body || {};
    if (!PKINDS.includes(b.kind)) return fail(res, 400, 'Unknown item type.');
    const content = String(b.content || '').slice(0, 40000); if (!content.trim()) return fail(res, 400, 'Nothing to save.');
    const m = b.meta && typeof b.meta === 'object' ? b.meta : {};
    const meta = {};
    for (const k of ['sensitivity', 'persona', 'audience']) if (typeof m[k] === 'string') meta[k] = m[k].slice(0, 20);
    if (Number.isFinite(m.count)) meta.count = Math.max(0, Math.min(9999, Math.floor(m.count)));
    const r = await sb('/rest/v1/project_items', req.token, { method: 'POST', prefer: 'return=representation', body: { project_id: req.params.id, team_id: t.id, kind: b.kind, title: String(b.title || '').slice(0, 120), content, meta, created_by: req.user, email: req.email } });
    if (!r.ok) return fail(res, 400, sbMsg(r, 'Could not save to the project.'));
    res.json({ item: Array.isArray(r.data) ? r.data[0] : r.data });
  }));
  app.delete('/api/projects/:id/items/:iid', requireAuth, wrap(async (req, res) => {
    if (!need(req, res)) return;
    if (!isUuid(req.params.id) || !isUuid(req.params.iid)) return fail(res, 400, 'Bad request.');
    const r = await sb(`/rest/v1/project_items?id=eq.${req.params.iid}&project_id=eq.${req.params.id}`, req.token, { method: 'DELETE', prefer: 'return=representation' });
    if (!r.ok) return fail(res, 400, sbMsg(r, 'Could not delete that item.'));
    if (!r.data || !r.data[0]) return fail(res, 403, 'Only the team owner or the person who saved it can delete it.');
    res.json({ ok: true });
  }));

  const cleanClient = body => {
    const label = String((body && body.label) || '').trim().slice(0, 60);
    const terms = [...new Set((Array.isArray(body && body.terms) ? body.terms : []).map(x => String(x).trim().slice(0, 100)).filter(Boolean))].slice(0, 60);
    return { label, terms };
  };
  app.post('/api/clients', requireAuth, json, wrap(async (req, res) => {
    if (!need(req, res)) return;
    const t = await loadTeam(req.token, req.user, false);
    if (!t || t.role !== 'owner') return fail(res, 403, 'Only the team owner can add clients.');
    const c = cleanClient(req.body);
    if (!c.label || !c.terms.length) return fail(res, 400, 'Add a label and at least one detail to hide.');
    const r = await sb('/rest/v1/clients', req.token, { method: 'POST', body: { team_id: t.id, ...c }, prefer: 'return=representation' });
    if (!r.ok) return fail(res, 400, sbMsg(r, 'Could not save the client.'));
    res.json({ client: Array.isArray(r.data) ? r.data[0] : r.data });
  }));
  app.put('/api/clients/:id', requireAuth, json, wrap(async (req, res) => {
    if (!need(req, res)) return;
    if (!isUuid(req.params.id)) return fail(res, 400, 'Bad request.');
    const t = await loadTeam(req.token, req.user, false);
    if (!t || t.role !== 'owner') return fail(res, 403, 'Only the team owner can edit clients.');
    const c = cleanClient(req.body);
    if (!c.label || !c.terms.length) return fail(res, 400, 'Add a label and at least one detail to hide.');
    const r = await sb(`/rest/v1/clients?id=eq.${req.params.id}&team_id=eq.${t.id}`, req.token, { method: 'PATCH', body: c, prefer: 'return=representation' });
    if (!r.ok) return fail(res, 400, sbMsg(r, 'Could not save the client.'));
    res.json({ client: Array.isArray(r.data) ? r.data[0] : r.data });
  }));
  app.delete('/api/clients/:id', requireAuth, wrap(async (req, res) => {
    if (!need(req, res)) return;
    if (!isUuid(req.params.id)) return fail(res, 400, 'Bad request.');
    const t = await loadTeam(req.token, req.user, false);
    if (!t || t.role !== 'owner') return fail(res, 403, 'Only the team owner can delete clients.');
    const r = await sb(`/rest/v1/clients?id=eq.${req.params.id}&team_id=eq.${t.id}`, req.token, { method: 'DELETE', prefer: 'return=minimal' });
    if (!r.ok) return fail(res, 400, sbMsg(r, 'Could not delete the client.'));
    res.json({ ok: true });
  }));
}
teamRoutes();

app.post('/api/login', express.json({ limit: '4kb' }), (req, res) => {
  if (SB_ON) return fail(res, 404, 'Use the account sign-in.');
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
  const info = { node: process.version, model: MODEL, keyPresent: ANTHROPIC_API_KEY.length > 0, usersConfigured: USERS.size, supabase: SB_ON, perHourLimit: RATE_PER_HOUR_USER };
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
  if (!['msg', 'brief', 'reply', 'plan'].includes(mode)) return fail(res, 400, 'Unknown mode.');

  const text = typeof b.text === 'string' ? b.text.trim() : '';
  const img = b.image && typeof b.image === 'object' ? b.image : null;
  if ((mode === 'reply' || mode === 'plan') && img) return fail(res, 400, 'Send this as text.');
  if ((text ? 1 : 0) + (img ? 1 : 0) !== 1) return fail(res, 400, 'Send either text or an image.');
  if (text.length > MAX_TEXT) return fail(res, 400, `Text is too long. The limit is ${MAX_TEXT.toLocaleString()} characters.`);
  if (img) {
    if (!IMAGE_TYPES.includes(img.media_type) && img.media_type !== 'application/pdf') return fail(res, 400, 'Unsupported file type. Use PNG, JPG, WEBP, GIF or PDF.');
    if (typeof img.data !== 'string' || !img.data || img.data.length > MAX_IMAGE_B64 || /[^A-Za-z0-9+/=\s]/.test(img.data.slice(0, 2000))) return fail(res, 400, 'The file is missing, invalid or larger than 5 MB.');
  }

  const tags = Array.isArray(b.tags) ? b.tags.filter(t => TAG_KEYS.includes(t)) : [];
  if (mode === 'msg' && tags.length === 0) return fail(res, 400, 'Select at least one thing to redact.');
  let custom = typeof b.custom === 'string' ? b.custom.trim().slice(0, MAX_NOTE) : '';
  const lst = v => Array.isArray(v) ? [...new Set(v.filter(x => typeof x === 'string').map(x => x.trim().slice(0, 100)).filter(x => x.length >= 1))].slice(0, 40) : [];
  const extra = lst(b.extra), keep = lst(b.keep);
  if (mode !== 'reply') {
    if (extra.length) custom = (custom ? custom + '\n' : '') + 'The reviewer also wants these exact words or phrases hidden everywhere: ' + extra.map(x => '"' + x + '"').join(', ');
    if (keep.length) custom = (custom ? custom + '\n' : '') + 'The reviewer decided these may stay visible, so do NOT redact them (unless they are in the saved client list or company rules): ' + keep.map(x => '"' + x + '"').join(', ');
  }
  const context = typeof b.context === 'string' ? b.context.trim().slice(0, MAX_NOTE) : '';

  const u = userLimit(req.user);
  if (!u.ok) return fail(res, 429, `Hourly limit reached. You can run more in ${Math.ceil(u.retryAfter / 60)} minutes.`);
  const ip = ipLimit(req.ip);
  if (!ip.ok) return fail(res, 429, 'Too many requests from this network. Please wait and try again.');

  let terms = [], rules = '', teamForLog = null, clientLabel = '';
  if (SB_ON) {
    let team;
    try { team = await loadTeam(req.token, req.user, false); } catch (e) { return fail(res, 502, 'Could not load your team: ' + e.message); }
    if (!team) return fail(res, 403, 'Create or join a team first.');
    teamForLog = team;
    if (mode !== 'reply') rules = team.rules.slice(0, 2000);
    if (mode !== 'reply' && b.clientId) {
      if (!isUuid(b.clientId)) return fail(res, 400, 'Unknown client.');
      const c = await sb(`/rest/v1/clients?select=label,terms&id=eq.${b.clientId}&team_id=eq.${team.id}`, req.token);
      if (!c.ok || !c.data || !c.data[0]) return fail(res, 400, 'That client was not found in your team.');
      clientLabel = String(c.data[0].label || '').slice(0, 60);
      terms = (c.data[0].terms || []).filter(t => typeof t === 'string' && t.trim().length >= 2).slice(0, 60);
    }
  } else if (mode !== 'reply' && Array.isArray(b.clientTerms)) {
    terms = [...new Set(b.clientTerms.filter(t => typeof t === 'string').map(t => t.trim().slice(0, 100)).filter(t => t.length >= 2))].slice(0, 60);
  }
  const clientName = typeof b.clientName === 'string' ? b.clientName.trim().slice(0, 60) : '';
  const tone = ['friendly', 'professional', 'brief'].includes(b.tone) ? { friendly: 'warm and friendly', professional: 'formal and professional', brief: 'very short and direct' }[b.tone] : 'professional but warm';
  const prompt = buildPrompt({ mode, text, hasImage: !!img, tags, custom, context, terms, clientName, tone, strict: mode === 'msg' && b.strict === true, rules, persona: b.persona === 'hardware' ? 'hardware' : 'software', audience: b.audience === 'client' ? 'client' : 'team' });
  const content = img
    ? [{ type: img.media_type === 'application/pdf' ? 'document' : 'image', source: { type: 'base64', media_type: img.media_type, data: img.data.replace(/\s/g, '') } }, { type: 'text', text: prompt }]
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
    if (data.stop_reason === 'max_tokens') return fail(res, 502, 'The reply was cut off because the input is very long. Try a shorter text or split the file in two.');
    const raw = (data.content || []).map(c => c.text || '').join('');
    const parsed = parseModelJson(raw);
    if (!parsed || typeof parsed !== 'object') {
      console.error('Unreadable AI reply:', raw.slice(0, 300));
      return fail(res, 502, 'The AI reply could not be read. Please try again.');
    }
    const result = normalise(parsed);
    const fixed = (mode === 'plan' && b.audience === 'client') ? [] : scrubTerms(result, terms);
    if (fixed.length) result.leaks_fixed = fixed;
    if (SB_ON && teamForLog) {
      sb('/rest/v1/activity', req.token, { method: 'POST', prefer: 'return=minimal', body: { team_id: teamForLog.id, user_id: req.user, email: req.email, mode, client_label: clientLabel || null, redacted: Array.isArray(result.redacted_items) ? result.redacted_items.length : null } })
        .then(r => { if (!r.ok) console.error('Activity log failed', r.status, JSON.stringify(r.data)); }).catch(e => console.error('Activity log error', e.message));
    }
    return res.json({ result });
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
  if (!SB_ON && USERS.size === 0) console.warn('WARNING: neither Supabase nor APP_USERS is set, so nobody can sign in');
  if (SB_ON) console.log('Sign-in: Supabase accounts');
});
