'use strict';
const http = require('http'), fs = require('fs'), os = require('os'), path = require('path');
const { spawn, spawnSync } = require('child_process');

const SRC = path.join(__dirname, '..', 'src');

// A fake OpenAI-compatible provider. `handler(req, body, count)` returns [status, obj, headers?].
function mockProvider(handler, modelIds = []) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => (raw += c));
    req.on('end', () => {
      let body = null; try { body = JSON.parse(raw); } catch {}
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
      if (req.url.endsWith('/models')) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ data: modelIds.map(id => ({ id })) })); }
      const [status, obj, headers] = handler(req, body, seen.length) || [200, { choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }];
      res.writeHead(status, { 'Content-Type': 'application/json', ...(headers || {}) });
      res.end(JSON.stringify(obj));
    });
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ server, seen, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(x => server.close(x)) })));
}

function freePort() {
  return new Promise(r => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
}

// Fresh AGT_HOME with a config pointing at mock providers.
async function setup(providers, lanes, extra = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agt-test-'));
  const port = await freePort();
  const cfg = { port, defaultLane: 'edit', providers, lanes, ...extra };
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(cfg));
  const env = { ...process.env, AGT_HOME: home, NO_COLOR: '1', HOME: home, USERPROFILE: home, AGT_NO_UPDATE_CHECK: '1', A_KEY: 'key-a', B_KEY: 'key-b' };
  return { home, port, env, base: `http://127.0.0.1:${port}` };
}

function startRouter(env) {
  const child = spawn(process.execPath, [path.join(SRC, 'router.js')], { env, stdio: 'ignore' });
  return child;
}
async function waitUp(base, ms = 5000) {
  const t = Date.now();
  while (Date.now() - t < ms) { try { const r = await fetch(base + '/health'); if (r.status) return; } catch {} await new Promise(r => setTimeout(r, 80)); }
  throw new Error('router did not start');
}
const post = (base, body) => fetch(base + '/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const cli = (args, env, extra = {}) => spawnSync(process.execPath, [path.join(SRC, 'cli.js'), ...args], { env, encoding: 'utf8', timeout: 30000, ...extra });

// Async variant: needed when a mock provider lives in this same process (spawnSync would freeze it).
const cliAsync = (args, env, extra = {}) => new Promise(resolve => {
  const ch = spawn(process.execPath, [path.join(SRC, 'cli.js'), ...args], { env, ...extra });
  let stdout = '', stderr = '';
  ch.stdout.on('data', d => (stdout += d)); ch.stderr.on('data', d => (stderr += d));
  ch.on('close', status => resolve({ status, stdout, stderr }));
});

module.exports = { cliAsync, SRC, mockProvider, setup, startRouter, waitUp, post, cli };
