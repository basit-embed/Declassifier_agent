const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 8080;

// Clean the key: trim whitespace/newlines and strip accidental quotes from the paste.
const RAW_KEY = process.env.ANTHROPIC_API_KEY || '';
const ANTHROPIC_API_KEY = RAW_KEY.trim().replace(/^["']|["']$/g, '').trim();

app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.static('public'));

async function callAnthropic(body) {
  return fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });
}

// Open this in a browser: https://YOUR-APP.onrender.com/api/health
app.get('/api/health', async (req, res) => {
  const info = {
    node: process.version,
    keyPresent: ANTHROPIC_API_KEY.length > 0,
    keyLength: ANTHROPIC_API_KEY.length,
    keyStartsWith: ANTHROPIC_API_KEY.slice(0, 7),
    keyHadExtraWhitespaceOrQuotes: RAW_KEY !== ANTHROPIC_API_KEY,
  };
  if (!info.keyPresent) return res.status(500).json({ ok: false, problem: 'ANTHROPIC_API_KEY is not set on the server', ...info });
  try {
    const r = await callAnthropic({ model: 'claude-sonnet-4-6', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] });
    const data = await r.json();
    if (!r.ok) return res.status(200).json({ ok: false, problem: 'Anthropic rejected the request', anthropicStatus: r.status, anthropicError: data.error || data, ...info });
    return res.json({ ok: true, message: 'Key works and Anthropic replied', ...info });
  } catch (err) {
    return res.status(200).json({ ok: false, problem: 'Server could not reach Anthropic', detail: String(err && err.message), cause: String(err && err.cause && (err.cause.message || err.cause.code)), ...info });
  }
});

app.post('/api/declassify', async (req, res) => {
  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: { message: 'ANTHROPIC_API_KEY is not set on the server' } });
  }
  try {
    const response = await callAnthropic(req.body);
    const data = await response.json();
    if (!response.ok) console.error('Anthropic error', response.status, JSON.stringify(data));
    res.status(response.status).json(data);
  } catch (err) {
    console.error('Proxy error:', err);
    res.status(500).json({ error: { message: 'Server error: ' + (err && err.message) + (err && err.cause ? ' (' + (err.cause.message || err.cause.code) + ')' : '') } });
  }
});

app.listen(PORT, () => console.log(`ClearPass proxy running on port ${PORT}`));
