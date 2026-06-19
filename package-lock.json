# ClearPass Server

Backend proxy + frontend for ClearPass. Keeps your Anthropic API key secure on the server.

## Deploy to Railway (recommended — free tier, 5 min)

1. Push this folder to a GitHub repo
2. Go to https://railway.app → New Project → Deploy from GitHub
3. Select your repo
4. Go to Variables tab → add: `ANTHROPIC_API_KEY` = `sk-ant-...`
5. Railway gives you a URL like `https://clearpass-production.up.railway.app`
6. Done — open the URL, no API key needed in browser

## Deploy to Render (also free)

1. Push to GitHub
2. Go to https://render.com → New → Web Service → connect repo
3. Build command: `npm install`
4. Start command: `node server.js`
5. Add env var: `ANTHROPIC_API_KEY` = your key
6. Deploy

## Local development

```bash
npm install
ANTHROPIC_API_KEY=sk-ant-... node server.js
# open http://localhost:3000
```
