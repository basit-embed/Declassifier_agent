<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>ClearPass — Message Declassifier</title>
<style>
  :root {
    --bg: #0d0f12;
    --surface: #161a20;
    --surface2: #1e232b;
    --border: rgba(255,255,255,0.07);
    --border2: rgba(255,255,255,0.13);
    --accent: #4f8ef7;
    --accent-dim: rgba(79,142,247,0.12);
    --accent-glow: rgba(79,142,247,0.25);
    --red: #e85c5c;
    --red-dim: rgba(232,92,92,0.12);
    --green: #3dba7e;
    --green-dim: rgba(61,186,126,0.12);
    --amber: #f0a94a;
    --amber-dim: rgba(240,169,74,0.12);
    --text: #e8eaf0;
    --text2: #8b909e;
    --text3: #555b6a;
    --mono: 'JetBrains Mono', 'Fira Code', 'Courier New', monospace;
    --sans: 'Inter', system-ui, -apple-system, sans-serif;
    --radius: 10px;
    --radius-lg: 16px;
  }

  * { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    background: var(--bg);
    color: var(--text);
    font-family: var(--sans);
    font-size: 15px;
    line-height: 1.6;
    min-height: 100vh;
  }

  /* ── NAV ── */
  nav {
    position: sticky; top: 0; z-index: 100;
    background: rgba(13,15,18,0.85);
    backdrop-filter: blur(12px);
    border-bottom: 1px solid var(--border);
    padding: 0 1.5rem;
    display: flex; align-items: center; justify-content: space-between;
    height: 56px;
  }
  .nav-brand { display: flex; align-items: center; gap: 10px; font-weight: 600; font-size: 16px; color: var(--text); text-decoration: none; }
  .nav-logo { width: 28px; height: 28px; background: var(--accent); border-radius: 7px; display: flex; align-items: center; justify-content: center; }
  .nav-logo svg { width: 16px; height: 16px; fill: none; stroke: white; stroke-width: 2.2; stroke-linecap: round; stroke-linejoin: round; }
  .nav-right { display: flex; align-items: center; gap: 12px; }
  .nav-pill { font-size: 12px; color: var(--text2); background: var(--surface2); border: 1px solid var(--border); border-radius: 99px; padding: 4px 12px; }
  .api-indicator { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text2); }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--green); animation: pulse 2s ease infinite; }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }

  /* ── LAYOUT ── */
  .container { max-width: 860px; margin: 0 auto; padding: 2.5rem 1.5rem 4rem; }

  /* ── HERO ── */
  .hero { text-align: center; margin-bottom: 3rem; }
  .hero-eyebrow { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 500; color: var(--accent); background: var(--accent-dim); border: 1px solid rgba(79,142,247,0.2); border-radius: 99px; padding: 4px 12px; margin-bottom: 1.25rem; letter-spacing: 0.04em; text-transform: uppercase; }
  .hero h1 { font-size: clamp(2rem, 5vw, 3rem); font-weight: 700; letter-spacing: -0.03em; line-height: 1.1; margin-bottom: 0.75rem; }
  .hero h1 span { color: var(--accent); }
  .hero p { color: var(--text2); font-size: 16px; max-width: 480px; margin: 0 auto; }



  /* ── CARD ── */
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg); padding: 1.5rem; margin-bottom: 1rem; }
  .card-title { font-size: 13px; font-weight: 600; color: var(--text2); letter-spacing: 0.04em; text-transform: uppercase; margin-bottom: 1rem; display: flex; align-items: center; gap: 8px; }
  .card-title svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }

  /* ── TABS ── */
  .tabs { display: flex; background: var(--surface2); border: 1px solid var(--border); border-radius: var(--radius); padding: 3px; gap: 3px; margin-bottom: 1.25rem; }
  .tab { flex: 1; padding: 8px; border: none; border-radius: 7px; background: transparent; color: var(--text2); font-size: 13px; font-weight: 500; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 6px; transition: all 0.15s; font-family: var(--sans); }
  .tab.active { background: var(--surface); color: var(--text); box-shadow: 0 1px 3px rgba(0,0,0,0.3); }
  .tab svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }

  /* ── TEXTAREA ── */
  textarea {
    width: 100%; min-height: 140px; resize: vertical;
    background: var(--surface2); border: 1px solid var(--border);
    border-radius: var(--radius); padding: 12px; color: var(--text);
    font-size: 14px; font-family: var(--sans); line-height: 1.6; outline: none;
    transition: border-color 0.15s;
  }
  textarea:focus { border-color: var(--accent); }
  textarea::placeholder { color: var(--text3); }

  /* ── UPLOAD ── */
  .upload-zone {
    border: 1px dashed var(--border2); border-radius: var(--radius);
    padding: 2rem; text-align: center; cursor: pointer;
    background: var(--surface2); transition: all 0.15s;
    position: relative;
  }
  .upload-zone:hover { border-color: var(--accent); background: var(--accent-dim); }
  .upload-zone.has-image { padding: 0.75rem; }
  .upload-zone input { position: absolute; inset: 0; opacity: 0; cursor: pointer; width: 100%; height: 100%; }
  .upload-icon { color: var(--text3); margin-bottom: 8px; }
  .upload-icon svg { width: 32px; height: 32px; fill: none; stroke: currentColor; stroke-width: 1.5; }
  .upload-label { font-size: 14px; color: var(--text2); }
  .upload-sub { font-size: 12px; color: var(--text3); margin-top: 4px; }
  #img-preview { max-width: 100%; max-height: 220px; border-radius: 8px; display: none; object-fit: contain; }

  /* ── REDACT TAGS ── */
  .tags-grid { display: flex; flex-wrap: wrap; gap: 8px; }
  .tag-btn {
    display: flex; align-items: center; gap: 6px;
    padding: 6px 13px; border-radius: 99px; font-size: 13px; font-weight: 500;
    border: 1px solid var(--border); background: var(--surface2);
    color: var(--text2); cursor: pointer; transition: all 0.15s;
    user-select: none; font-family: var(--sans);
  }
  .tag-btn svg { width: 13px; height: 13px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
  .tag-btn:hover { border-color: var(--border2); color: var(--text); }
  .tag-btn.on { background: var(--accent-dim); border-color: rgba(79,142,247,0.35); color: var(--accent); }

  /* ── CUSTOM RULES ── */
  .custom-rules-wrap { margin-top: 1rem; }
  .custom-rules-wrap label { font-size: 13px; color: var(--text2); display: block; margin-bottom: 6px; }
  .custom-rules-wrap textarea { min-height: 72px; font-family: var(--mono); font-size: 12px; }

  /* ── RUN BUTTON ── */
  .run-btn {
    width: 100%; padding: 13px; font-size: 15px; font-weight: 600;
    background: var(--accent); color: white; border: none;
    border-radius: var(--radius); cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 8px;
    transition: all 0.15s; font-family: var(--sans); letter-spacing: -0.01em; margin-top: 1rem;
  }
  .run-btn:hover:not(:disabled) { background: #6aa0f8; }
  .run-btn:active:not(:disabled) { transform: scale(0.99); }
  .run-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .run-btn svg { width: 16px; height: 16px; fill: none; stroke: white; stroke-width: 2.2; stroke-linecap: round; stroke-linejoin: round; }
  .spinner-ring { width: 16px; height: 16px; border: 2px solid rgba(255,255,255,0.3); border-top-color: white; border-radius: 50%; animation: spin 0.7s linear infinite; flex-shrink: 0; }
  @keyframes spin { to { transform: rotate(360deg); } }

  /* ── OUTPUT ── */
  #output-wrap { display: none; }
  #output-wrap.show { display: block; }

  .output-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg); overflow: hidden; margin-bottom: 1rem; }
  .output-header { padding: 1rem 1.5rem; border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; }
  .output-header-left { display: flex; align-items: center; gap: 10px; }
  .status-badge { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; padding: 4px 12px; border-radius: 99px; }
  .status-low { background: var(--green-dim); color: var(--green); border: 1px solid rgba(61,186,126,0.2); }
  .status-medium { background: var(--amber-dim); color: var(--amber); border: 1px solid rgba(240,169,74,0.2); }
  .status-high { background: var(--red-dim); color: var(--red); border: 1px solid rgba(232,92,92,0.2); }
  .output-actions { display: flex; gap: 8px; }
  .action-btn { display: flex; align-items: center; gap: 5px; padding: 6px 12px; font-size: 12px; font-weight: 500; background: var(--surface2); border: 1px solid var(--border); border-radius: var(--radius); color: var(--text2); cursor: pointer; transition: all 0.15s; font-family: var(--sans); }
  .action-btn:hover { border-color: var(--border2); color: var(--text); }
  .action-btn svg { width: 12px; height: 12px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }

  .output-body { padding: 1.5rem; }
  .output-section-label { font-size: 11px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text3); margin-bottom: 8px; }
  .message-box { background: var(--surface2); border: 1px solid var(--border); border-radius: var(--radius); padding: 1rem; font-size: 14px; line-height: 1.75; color: var(--text); white-space: pre-wrap; word-break: break-word; }
  .redact-token { background: rgba(232,92,92,0.15); color: #f47f7f; border: 1px solid rgba(232,92,92,0.25); border-radius: 4px; padding: 1px 6px; font-family: var(--mono); font-size: 12px; }
  .divider { border: none; border-top: 1px solid var(--border); margin: 1.25rem 0; }
  .summary-box { background: var(--accent-dim); border: 1px solid rgba(79,142,247,0.2); border-radius: var(--radius); padding: 1rem; font-size: 14px; color: var(--text); line-height: 1.6; }

  /* ── REDACTED LIST ── */
  .redacted-table { width: 100%; border-collapse: collapse; font-size: 13px; }
  .redacted-table th { text-align: left; padding: 6px 8px; font-size: 11px; font-weight: 600; color: var(--text3); letter-spacing: 0.05em; text-transform: uppercase; border-bottom: 1px solid var(--border); }
  .redacted-table td { padding: 8px 8px; border-bottom: 1px solid var(--border); color: var(--text2); vertical-align: top; }
  .redacted-table tr:last-child td { border-bottom: none; }
  .redacted-table td.original { color: var(--red); font-family: var(--mono); font-size: 12px; }
  .redacted-table td.category { color: var(--text3); font-size: 12px; }
  .no-redactions { color: var(--text3); font-size: 14px; font-style: italic; text-align: center; padding: 1rem; }

  /* ── HISTORY ── */
  .history-section { margin-top: 2.5rem; }
  .history-title { font-size: 13px; font-weight: 600; color: var(--text2); letter-spacing: 0.04em; text-transform: uppercase; margin-bottom: 1rem; display: flex; align-items: center; justify-content: space-between; }
  .history-clear { font-size: 12px; color: var(--text3); background: none; border: none; cursor: pointer; font-family: var(--sans); }
  .history-clear:hover { color: var(--red); }
  .history-list { display: flex; flex-direction: column; gap: 8px; }
  .history-item { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 0.875rem 1rem; cursor: pointer; transition: border-color 0.15s; }
  .history-item:hover { border-color: var(--border2); }
  .history-item-top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px; }
  .history-time { font-size: 11px; color: var(--text3); }
  .history-preview { font-size: 13px; color: var(--text2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .history-meta { display: flex; gap: 8px; margin-top: 6px; }
  .history-badge { font-size: 11px; padding: 2px 8px; border-radius: 99px; font-weight: 500; }

  /* ── TOAST ── */
  #toast { position: fixed; bottom: 1.5rem; right: 1.5rem; background: var(--surface2); border: 1px solid var(--border2); border-radius: var(--radius); padding: 10px 16px; font-size: 13px; color: var(--text); z-index: 999; opacity: 0; transform: translateY(8px); transition: all 0.2s; pointer-events: none; }
  #toast.show { opacity: 1; transform: translateY(0); }

  /* ── FOOTER ── */
  footer { text-align: center; padding: 2rem 1.5rem; border-top: 1px solid var(--border); color: var(--text3); font-size: 12px; margin-top: 3rem; }
  footer a { color: var(--text2); text-decoration: none; }
  footer a:hover { color: var(--text); }

  /* ── RESPONSIVE ── */
  @media (max-width: 600px) {
    .container { padding: 1.5rem 1rem 3rem; }
    .hero h1 { font-size: 1.75rem; }
    .output-header { flex-direction: column; align-items: flex-start; }
  }
</style>
</head>
<body>

<!-- NAV -->
<nav>
  <a href="#" class="nav-brand">
    <div class="nav-logo">
      <svg viewBox="0 0 24 24"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
    </div>
    ClearPass
  </a>
  <div class="nav-right">
    <div class="api-indicator"><div class="dot"></div> Claude API</div>
    <div class="nav-pill" id="history-count">0 processed</div>
  </div>
</nav>

<!-- MAIN -->
<main class="container">

  <!-- HERO -->
  <div class="hero">
    <div class="hero-eyebrow">
      <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
      Confidential message declassifier
    </div>
    <h1>Strip sensitive info.<br /><span>Share only what matters.</span></h1>
    <p>Paste client messages or upload screenshots. ClearPass redacts confidential details so your technical team gets the task, not the secrets.</p>
  </div>



  <!-- INPUT CARD -->
  <div class="card">
    <div class="card-title">
      <svg viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
      Client message
    </div>

    <div class="tabs">
      <button class="tab active" id="tab-text" onclick="switchTab('text')">
        <svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
        Text message
      </button>
      <button class="tab" id="tab-image" onclick="switchTab('image')">
        <svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
        Image / screenshot
      </button>
    </div>

    <div id="text-panel">
      <textarea id="msg-input" placeholder="Paste the client's message, email, or request here…"></textarea>
    </div>

    <div id="image-panel" style="display:none">
      <div class="upload-zone" id="upload-zone">
        <input type="file" id="file-input" accept="image/*" onchange="handleImage(event)" />
        <div id="upload-placeholder">
          <div class="upload-icon">
            <svg viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
          </div>
          <div class="upload-label">Click or drag to upload</div>
          <div class="upload-sub">PNG, JPG, WEBP — screenshots, emails, docs</div>
        </div>
        <img id="img-preview" alt="Uploaded preview" />
      </div>
    </div>
  </div>

  <!-- REDACT CONFIG -->
  <div class="card">
    <div class="card-title">
      <svg viewBox="0 0 24 24"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>
      What to redact
    </div>
    <div class="tags-grid" id="tags-grid">
      <!-- injected by JS -->
    </div>
    <div class="custom-rules-wrap">
      <label>Custom rules (optional) — describe anything else to redact, one per line</label>
      <textarea id="custom-rules" placeholder="e.g. Any mention of the word 'prototype'&#10;References to our pricing model&#10;Internal team member names"></textarea>
    </div>
  </div>

  <!-- OUTPUT CONTEXT -->
  <div class="card">
    <div class="card-title">
      <svg viewBox="0 0 24 24"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
      Team context (optional)
    </div>
    <textarea id="team-context" placeholder="e.g. This is going to the frontend dev team. Focus on technical tasks only. They need to know about UI bugs, API changes, feature requests — not timelines or costs." style="min-height:80px;"></textarea>
  </div>

  <button class="run-btn" id="run-btn" onclick="runAgent()">
    <svg viewBox="0 0 24 24"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
    Declassify message
  </button>

  <!-- OUTPUT -->
  <div id="output-wrap">
    <div class="output-card" id="output-card">
      <div class="output-header">
        <div class="output-header-left">
          <span id="sensitivity-badge" class="status-badge"></span>
          <span id="redact-count" style="font-size:13px; color:var(--text2);"></span>
        </div>
        <div class="output-actions">
          <button class="action-btn" onclick="copyOutput()">
            <svg viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
            Copy for team
          </button>
          <button class="action-btn" onclick="downloadOutput()">
            <svg viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 0-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            Download
          </button>
        </div>
      </div>
      <div class="output-body">
        <div class="output-section-label">Declassified message — safe to share</div>
        <div class="message-box" id="output-msg"></div>
        <div class="divider"></div>
        <div class="output-section-label">Task summary for team</div>
        <div class="summary-box" id="output-summary"></div>
        <div class="divider"></div>
        <div class="output-section-label">What was redacted</div>
        <div id="output-redacted-wrap"></div>
      </div>
    </div>
  </div>

  <!-- HISTORY -->
  <div class="history-section" id="history-section" style="display:none">
    <div class="history-title">
      Recent sessions
      <button class="history-clear" onclick="clearHistory()">Clear all</button>
    </div>
    <div class="history-list" id="history-list"></div>
  </div>

</main>

<footer>
  ClearPass — built with Claude AI &nbsp;·&nbsp; API key stays in your browser &nbsp;·&nbsp; <a href="https://docs.anthropic.com" target="_blank">Anthropic docs</a>
</footer>

<div id="toast"></div>

<script>
// ── STATE ──
let activeTab = 'text';
let imageBase64 = null;
let imageMediaType = null;
let history = [];
let currentOutput = null;

const TAGS = [
  { key: 'client_name',   label: 'Client name',    icon: `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`, on: true },
  { key: 'budget',        label: 'Budget / amounts',icon: `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>`, on: true },
  { key: 'company',       label: 'Company name',    icon: `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>`, on: true },
  { key: 'contact_info',  label: 'Contact info',    icon: `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 13a19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 3.77 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l.91-.91a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>`, on: true },
  { key: 'location',      label: 'Location',        icon: `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>`, on: true },
  { key: 'dates',         label: 'Dates / deadlines',icon:`<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>`, on: true },
  { key: 'project_name',  label: 'Project name',    icon: `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`, on: false },
  { key: 'legal',         label: 'Legal / contracts',icon:`<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`, on: false },
  { key: 'personal_details', label: 'Personal details', icon:`<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="20" height="20" rx="2"/><path d="M7 11l5-5 5 5"/><path d="M12 6v12"/></svg>`, on: false },
];

// ── INIT ──
(function init() {
  renderTags();
  loadHistory();
  const saved = localStorage.getItem('cp_apikey');
  if (saved) {
    document.getElementById('api-key-input').value = saved;
    document.getElementById('setup-banner').style.display = 'none';
  }
})();

function renderTags() {
  const grid = document.getElementById('tags-grid');
  grid.innerHTML = TAGS.map(t => `
    <button class="tag-btn ${t.on ? 'on' : ''}" data-key="${t.key}" onclick="toggleTag(this)">
      ${t.icon} ${t.label}
    </button>
  `).join('');
}

function toggleTag(el) {
  el.classList.toggle('on');
}

function getActiveTags() {
  return Array.from(document.querySelectorAll('.tag-btn.on')).map(b => b.dataset.key);
}



// ── TABS ──
function switchTab(tab) {
  activeTab = tab;
  document.getElementById('text-panel').style.display = tab === 'text' ? 'block' : 'none';
  document.getElementById('image-panel').style.display = tab === 'image' ? 'block' : 'none';
  document.getElementById('tab-text').classList.toggle('active', tab === 'text');
  document.getElementById('tab-image').classList.toggle('active', tab === 'image');
}

// ── IMAGE UPLOAD ──
function handleImage(e) {
  const file = e.target.files[0];
  if (!file) return;
  imageMediaType = file.type;
  const reader = new FileReader();
  reader.onload = ev => {
    imageBase64 = ev.target.result.split(',')[1];
    const preview = document.getElementById('img-preview');
    preview.src = ev.target.result;
    preview.style.display = 'block';
    document.getElementById('upload-placeholder').style.display = 'none';
    document.getElementById('upload-zone').classList.add('has-image');
  };
  reader.readAsDataURL(file);
}

// ── RUN ──
async function runAgent() {
  const tags = getActiveTags();
  if (!tags.length) { toast('Select at least one redaction category'); return; }

  let userContent = [];

  if (activeTab === 'text') {
    const msg = document.getElementById('msg-input').value.trim();
    if (!msg) { toast('Paste a client message first'); return; }
    userContent = [{ type: 'text', text: buildTextPrompt(msg, tags) }];
  } else {
    if (!imageBase64) { toast('Upload an image first'); return; }
    userContent = [
      { type: 'image', source: { type: 'base64', media_type: imageMediaType, data: imageBase64 } },
      { type: 'text', text: buildImagePrompt(tags) }
    ];
  }

  const btn = document.getElementById('run-btn');
  btn.disabled = true;
  btn.innerHTML = '<div class="spinner-ring"></div> Declassifying…';
  document.getElementById('output-wrap').classList.remove('show');

  try {
    const res = await fetch('/api/declassify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1500,
        system: `You are a confidential message declassification agent. You strip sensitive business information from client messages before sharing with technical employees. Return ONLY valid JSON. No markdown fences. No extra text.`,
        messages: [{ role: 'user', content: userContent }]
      })
    });

    const data = await res.json();
    if (data.error) { toast('API error: ' + data.error.message); return; }

    const raw = data.content.map(i => i.text || '').join('');
    const clean = raw.replace(/^```json\s*|```\s*$/g, '').trim();
    const parsed = JSON.parse(clean);

    currentOutput = parsed;
    renderOutput(parsed);
    saveHistory(parsed);
  } catch (err) {
    console.error(err);
    toast('Error: ' + err.message);
  }

  btn.disabled = false;
  btn.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="white" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg> Declassify message`;
}

function buildTextPrompt(msg, tags) {
  const custom = document.getElementById('custom-rules').value.trim();
  const ctx = document.getElementById('team-context').value.trim();
  return `Declassify this client message. Redact: ${tags.join(', ')}${custom ? `\nAlso redact: ${custom}` : ''}.
${ctx ? `Team context: ${ctx}` : ''}

Client message:
"""
${msg}
"""

Return ONLY this JSON (no markdown):
{
  "declassified_message": "full message with sensitive parts replaced by [REDACTED: CATEGORY] tokens",
  "redacted_items": [{"category": "client_name|budget|etc", "original": "the actual text found", "token": "[REDACTED: CATEGORY]"}],
  "summary_for_team": "1-2 sentence plain task summary with zero sensitive information",
  "sensitivity_level": "low|medium|high",
  "redact_count": 3
}`;
}

function buildImagePrompt(tags) {
  const custom = document.getElementById('custom-rules').value.trim();
  const ctx = document.getElementById('team-context').value.trim();
  return `Read all text in this image then declassify it. Redact: ${tags.join(', ')}${custom ? `\nAlso redact: ${custom}` : ''}.
${ctx ? `Team context: ${ctx}` : ''}

Return ONLY this JSON (no markdown):
{
  "extracted_text": "all text from the image verbatim",
  "declassified_message": "same text but sensitive parts replaced by [REDACTED: CATEGORY] tokens",
  "redacted_items": [{"category": "client_name|budget|etc", "original": "the actual text", "token": "[REDACTED: CATEGORY]"}],
  "summary_for_team": "1-2 sentence plain task summary with zero sensitive information",
  "sensitivity_level": "low|medium|high",
  "redact_count": 3
}`;
}

// ── RENDER OUTPUT ──
function renderOutput(d) {
  const levelMap = { low: ['status-low', '🟢 Low sensitivity'], medium: ['status-medium', '🟡 Medium sensitivity'], high: ['status-high', '🔴 High sensitivity'] };
  const [cls, label] = levelMap[d.sensitivity_level] || ['status-medium', 'Unknown'];
  document.getElementById('sensitivity-badge').className = 'status-badge ' + cls;
  document.getElementById('sensitivity-badge').textContent = label;
  document.getElementById('redact-count').textContent = `${(d.redacted_items || []).length} item${(d.redacted_items||[]).length !== 1 ? 's' : ''} redacted`;

  const msgEl = document.getElementById('output-msg');
  let html = escHtml(d.declassified_message || '');
  html = html.replace(/\[REDACTED:[^\]]*\]/g, m => `<span class="redact-token">${m}</span>`);
  msgEl.innerHTML = html;

  document.getElementById('output-summary').textContent = d.summary_for_team || '—';

  const redWrap = document.getElementById('output-redacted-wrap');
  if (!d.redacted_items || d.redacted_items.length === 0) {
    redWrap.innerHTML = '<div class="no-redactions">Nothing sensitive detected in this message.</div>';
  } else {
    redWrap.innerHTML = `<table class="redacted-table">
      <thead><tr><th>Category</th><th>Original value</th><th>Replaced with</th></tr></thead>
      <tbody>${d.redacted_items.map(r => `
        <tr>
          <td class="category">${escHtml(r.category || '')}</td>
          <td class="original">${escHtml(r.original || '')}</td>
          <td style="font-family:var(--mono);font-size:12px;color:var(--text3)">${escHtml(r.token || '')}</td>
        </tr>`).join('')}
      </tbody>
    </table>`;
  }

  document.getElementById('output-wrap').classList.add('show');
  document.getElementById('output-wrap').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ── COPY / DOWNLOAD ──
function copyOutput() {
  if (!currentOutput) return;
  const text = `DECLASSIFIED MESSAGE\n${'─'.repeat(40)}\n${currentOutput.declassified_message}\n\n${'─'.repeat(40)}\nTASK SUMMARY\n${currentOutput.summary_for_team}`;
  navigator.clipboard.writeText(text).then(() => toast('Copied to clipboard'));
}

function downloadOutput() {
  if (!currentOutput) return;
  const ts = new Date().toISOString().slice(0,19).replace(/[T:]/g, '-');
  const text = `CLEARPASS DECLASSIFIED MESSAGE\nGenerated: ${new Date().toLocaleString()}\nSensitivity: ${currentOutput.sensitivity_level}\nItems redacted: ${(currentOutput.redacted_items||[]).length}\n\n${'='.repeat(50)}\nDECLASSIFIED MESSAGE\n${'='.repeat(50)}\n${currentOutput.declassified_message}\n\n${'='.repeat(50)}\nTASK SUMMARY FOR TEAM\n${'='.repeat(50)}\n${currentOutput.summary_for_team}\n\n${'='.repeat(50)}\nREDACTION LOG\n${'='.repeat(50)}\n${(currentOutput.redacted_items||[]).map(r=>`[${r.category}] "${r.original}" → ${r.token}`).join('\n')}`;
  const blob = new Blob([text], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `clearpass-${ts}.txt`; a.click();
  URL.revokeObjectURL(url);
}

// ── HISTORY ──
function saveHistory(d) {
  const entry = {
    id: Date.now(),
    time: new Date().toLocaleString(),
    preview: (d.declassified_message || '').slice(0, 80),
    sensitivity: d.sensitivity_level,
    count: (d.redacted_items || []).length,
    data: d
  };
  history.unshift(entry);
  if (history.length > 10) history.pop();
  localStorage.setItem('cp_history', JSON.stringify(history));
  renderHistory();
}

function loadHistory() {
  try { history = JSON.parse(localStorage.getItem('cp_history') || '[]'); } catch { history = []; }
  renderHistory();
}

function clearHistory() {
  history = [];
  localStorage.removeItem('cp_history');
  renderHistory();
}

function renderHistory() {
  const sec = document.getElementById('history-section');
  const list = document.getElementById('history-list');
  document.getElementById('history-count').textContent = history.length + ' processed';
  if (!history.length) { sec.style.display = 'none'; return; }
  sec.style.display = 'block';
  const lvlCls = { low: 'status-low', medium: 'status-medium', high: 'status-high' };
  list.innerHTML = history.map(h => `
    <div class="history-item" onclick="restoreHistory(${h.id})">
      <div class="history-item-top">
        <div class="history-meta">
          <span class="history-badge status-badge ${lvlCls[h.sensitivity] || 'status-medium'}" style="font-size:11px; padding:2px 8px;">${h.sensitivity}</span>
          <span class="history-badge" style="background:var(--surface2);color:var(--text2);border:1px solid var(--border);font-size:11px;padding:2px 8px;">${h.count} redacted</span>
        </div>
        <span class="history-time">${h.time}</span>
      </div>
      <div class="history-preview">${escHtml(h.preview)}…</div>
    </div>
  `).join('');
}

function restoreHistory(id) {
  const entry = history.find(h => h.id === id);
  if (!entry) return;
  currentOutput = entry.data;
  renderOutput(entry.data);
}

// ── UTILS ──
function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2500);
}
</script>
</body>
</html>
