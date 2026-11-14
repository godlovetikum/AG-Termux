'use strict';
const http = require('http'), fs = require('fs');
const G = require('./common');
const { P } = G;

G.ensureDirs();
require('./keys').loadKeys();
G.rotate(P.routerLog);
let CFG;
try { CFG = G.loadConfig(); } catch (e) { console.error(e.message); process.exit(2); }

const started = Date.now();
const cooling = {};   // "provider/model" -> time it may be used again
const session = {};   // counts since this router started
let daily = {};       // UTC date -> "provider/model" -> { ok, fail }
let dirty = false, logCount = 0;
try { daily = JSON.parse(fs.readFileSync(P.stats, 'utf8')).daily || {}; } catch {}

function log(level, event, data = {}) {
  const rec = { ts: new Date().toISOString(), level, event, ...data };
  G.appendJsonl(P.routerLog, rec);
  if (++logCount % 200 === 0) G.rotate(P.routerLog);
  if (process.stdout.isTTY) console.log(G.formatLog(rec));
}
function bump(k, f) {
  const d = new Date().toISOString().slice(0, 10);
  daily[d] = daily[d] || {}; daily[d][k] = daily[d][k] || { ok: 0, fail: 0 }; daily[d][k][f]++;
  session[k] = session[k] || { ok: 0, fail: 0 }; session[k][f]++;
  dirty = true;
}
function saveStats() {
  if (!dirty) return;
  daily = Object.fromEntries(Object.keys(daily).sort().slice(-7).map(d => [d, daily[d]]));
  try { fs.writeFileSync(P.stats + '.tmp', JSON.stringify({ daily })); fs.renameSync(P.stats + '.tmp', P.stats); dirty = false; }
  catch (e) { log('warn', 'stats_save_failed', { error: e.message }); }
}
setInterval(saveStats, 5000).unref();

const send = (res, code, obj, headers = {}) => { res.writeHead(code, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(obj, null, 2)); };
const hostOk = h => /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(h || '');

function readBody(req, limit = 20e6) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', ch => { n += ch.length; if (n > limit) { reject(new Error('request body too large')); req.destroy(); } else chunks.push(ch); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// Gemini-only fields (thought signatures) and reasoning text confuse other providers.
// Going the other way, Gemini 3 rejects tool calls that carry no signature (for example
// ones written by Groq), so those get Google's documented dummy value.
function cleanFor(name, body) {
  const p = CFG.providers[name];
  if (!Array.isArray(body.messages)) return body;
  if (p && p.keepGeminiFields) return {
    ...body,
    messages: body.messages.map(m => !Array.isArray(m.tool_calls) ? m : { ...m, tool_calls: m.tool_calls.map(tc => (tc.extra_content && tc.extra_content.google && tc.extra_content.google.thought_signature ? tc : { ...tc, extra_content: { google: { thought_signature: 'skip_thought_signature_validator' } } })) }),
  };
  return {
    ...body,
    messages: body.messages.map(m => {
      const { extra_content, reasoning, reasoning_content, ...rest } = m;
      if (Array.isArray(rest.tool_calls)) rest.tool_calls = rest.tool_calls.map(({ extra_content, ...tc }) => tc);
      return rest;
    }),
  };
}
function cooldownMs(status, r) {
  if (status === 429) { const ra = Number(r.headers.get('retry-after')); return ra > 0 ? Math.min(ra, 3600) * 1000 : CFG.cooldownSec * 1000; }
  if (status === 401 || status === 403 || status === 404) return 15 * 60 * 1000; // bad key or model: won't fix itself soon
  if (status >= 500) return 60 * 1000;
  return 0;
}

function health() {
  const now = Date.now();
  const providers = Object.entries(CFG.providers).map(([name, p]) => ({ name, keyEnv: p.keyEnv, configured: !!G.keyOf(CFG, name) }));
  const lanes = {};
  for (const [name, steps] of Object.entries(CFG.lanes || {})) {
    const valid = steps.filter(s => Array.isArray(s) && G.keyOf(CFG, s[0]));
    const ready = valid.filter(([p, m]) => !(cooling[p + '/' + m] > now));
    lanes[name] = { steps: steps.length, configured: valid.length, ready: ready.length, next: ready[0] ? ready[0].join('/') : null };
  }
  const L = Object.values(lanes);
  let status = 'ok';
  if (!L.length || L.every(l => l.ready === 0)) status = 'down';
  else if (L.some(l => l.ready === 0 || l.ready < l.configured)) status = 'degraded';
  const cool = Object.fromEntries(Object.entries(cooling).filter(([, t]) => t > now).map(([k, t]) => [k, Math.round((t - now) / 1000)]));
  return { status, version: G.VERSION, pid: process.pid, port: CFG.port, uptime_s: Math.round((now - started) / 1000), providers, lanes, cooling: cool, issues: G.validateConfig(CFG) };
}

async function handleChat(req, res) {
  const rid = Math.random().toString(36).slice(2, 8);
  let body;
  try { body = JSON.parse(await readBody(req)); } catch (e) { return send(res, 400, { error: { message: 'bad request: ' + e.message } }, { 'x-router-id': rid }); }
  // body.model is a lane name, an alias, or one pinned "provider/model" (no failover for a pin)
  let target = G.resolveTarget(CFG, body.model);
  if (!target) { log('warn', 'unknown_target', { id: rid, asked: body.model, using: CFG.defaultLane }); target = G.resolveTarget(CFG, CFG.defaultLane); }
  const lane = target.label, pinned = target.type === 'model';

  const usable = target.steps.filter(s => Array.isArray(s) && G.keyOf(CFG, s[0]));
  if (!usable.length) {
    const need = target.steps.map(s => s[0] && CFG.providers[s[0]] && CFG.providers[s[0]].keyEnv).filter(Boolean).join(', ');
    log('error', 'no_providers', { id: rid, lane, need });
    return send(res, 503, { error: { message: `"${lane}" has no usable provider. Set: ${need}` } }, { 'x-router-id': rid });
  }
  let steps = pinned ? usable : usable.filter(([p, m]) => !(cooling[p + '/' + m] > Date.now()));
  if (!steps.length) steps = usable; // everything parked: try anyway

  const ctl = new AbortController();
  res.on('close', () => { if (!res.writableEnded) ctl.abort(); });
  const attempts = [];

  const retried = {};
  for (let si = 0; si < steps.length; si++) {
    const [p, m] = steps[si];
    const k = p + '/' + m, t0 = Date.now();
    try {
      const r = await fetch(CFG.providers[p].url + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + G.keyOf(CFG, p) },
        body: JSON.stringify({ ...cleanFor(p, body), model: m }),
        signal: AbortSignal.any([ctl.signal, AbortSignal.timeout(CFG.requestTimeoutSec * 1000)]),
      });
      const ms = Date.now() - t0;
      if (r.ok) {
        bump(k, 'ok');
        log('info', 'request', { id: rid, lane, via: k, status: r.status, ms, attempts: attempts.length + 1, msgs: (body.messages || []).length, stream: !!body.stream });
        res.writeHead(200, { 'Content-Type': r.headers.get('content-type') || 'application/json', 'x-router-id': rid, 'x-router-lane': lane, 'x-router-via': k, 'x-router-attempts': String(attempts.length + 1) });
        try { for await (const chunk of r.body) res.write(chunk); } catch (e) { log('warn', 'stream_error', { id: rid, via: k, error: e.message }); }
        return res.end();
      }
      const text = await r.text();
      if (r.status === 429 && !retried[k]) {
        const hdr = Number(r.headers.get('retry-after'));
        const mt = /try again in ([0-9.]+) ?(ms|s)/i.exec(text);
        const wait = hdr > 0 ? hdr : mt ? (mt[2].toLowerCase() === 'ms' ? Number(mt[1]) / 1000 : Number(mt[1])) : 0;
        if (wait > 0 && wait <= 15) {
          retried[k] = true;
          log('info', 'rate_limit_wait', { id: rid, via: k, wait_s: wait });
          await new Promise(done => setTimeout(done, wait * 1000 + 300));
          si--;
          continue;
        }
      }
      const cd = cooldownMs(r.status, r);
      if (cd) cooling[k] = Date.now() + cd;
      bump(k, 'fail');
      attempts.push({ via: k, status: r.status, ms, error: text });
      log('warn', 'attempt_failed', { id: rid, lane, via: k, status: r.status, ms, cooldown_s: Math.round(cd / 1000), error: text.slice(0, 4000) });
    } catch (e) {
      if (ctl.signal.aborted) { log('info', 'client_aborted', { id: rid, lane }); return; }
      bump(k, 'fail');
      cooling[k] = Date.now() + 60000;
      const why = e.name === 'TimeoutError' ? `timed out after ${CFG.requestTimeoutSec}s` : e.message;
      attempts.push({ via: k, status: 0, ms: Date.now() - t0, error: why });
      log('warn', 'attempt_failed', { id: rid, lane, via: k, status: 0, error: why });
    }
  }
  log('error', 'all_failed', { id: rid, lane, tried: attempts.map(a => a.via) });
  send(res, 503, { error: { message: `all providers failed for lane "${lane}"`, attempts } }, { 'x-router-id': rid });
}

const server = http.createServer(async (req, res) => {
  try {
    if (!hostOk(req.headers.host)) return send(res, 403, { error: { message: 'bad Host header' } });
    if (req.method === 'POST' && !/application\/json/i.test(req.headers['content-type'] || '')) return send(res, 415, { error: { message: 'Content-Type must be application/json' } });
    const url = new URL(req.url, 'http://x');
    const route = req.method + ' ' + url.pathname.replace(/^\/v1(?=\/)/, '');
    switch (route) {
      case 'GET /health': {
        const h = health();
        if (url.searchParams.get('deep')) h.probes = await Promise.all(h.providers.filter(p => p.configured).map(p => G.probeProvider(CFG, p.name)));
        return send(res, h.status === 'down' ? 503 : 200, h);
      }
      case 'GET /stats': return send(res, 200, { uptime_s: Math.round((Date.now() - started) / 1000), since_start: session, daily });
      case 'GET /config': return send(res, 200, CFG);
      case 'GET /models': return send(res, 200, { object: 'list', data: [...Object.keys(CFG.lanes), ...Object.keys(CFG.aliases || {})].map(id => ({ id, object: 'model' })) });
      case 'POST /chat/completions': return handleChat(req, res);
      case 'POST /admin/reset': for (const k of Object.keys(cooling)) delete cooling[k]; log('info', 'cooldowns_reset'); return send(res, 200, { ok: true });
      case 'POST /admin/reload':
        try { CFG = G.loadConfig(); log('info', 'config_reloaded'); return send(res, 200, { ok: true, issues: G.validateConfig(CFG) }); }
        catch (e) { return send(res, 400, { ok: false, error: e.message }); }
      case 'POST /admin/shutdown': send(res, 200, { ok: true }); return setTimeout(() => shutdown(0), 100);
      default: return send(res, 404, { error: { message: 'not found', routes: ['GET /health[?deep=1]', 'GET /stats', 'GET /config', 'GET /v1/models', 'POST /v1/chat/completions', 'POST /admin/reset|reload|shutdown'] } });
    }
  } catch (e) {
    log('error', 'handler_error', { error: e.stack });
    if (!res.headersSent) send(res, 500, { error: { message: e.message } }); else res.end();
  }
});

function shutdown(code) {
  log('info', 'shutdown');
  saveStats();
  try { if (fs.readFileSync(P.pid, 'utf8').trim() === String(process.pid)) fs.unlinkSync(P.pid); } catch {}
  server.close();
  setTimeout(() => process.exit(code), 300).unref();
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
process.on('uncaughtException', e => { log('error', 'uncaught', { error: e.stack }); shutdown(1); });

server.on('error', e => {
  if (e.code === 'EADDRINUSE') { log('error', 'port_in_use', { port: CFG.port }); console.error(`port ${CFG.port} is already in use (is another router running?)`); process.exit(3); }
  throw e;
});
server.listen(CFG.port, '127.0.0.1', () => {
  try { fs.writeFileSync(P.pid, String(process.pid)); } catch {}
  log('info', 'start', { port: CFG.port, pid: process.pid, version: G.VERSION, node: process.version, providers: Object.keys(CFG.providers).filter(n => G.keyOf(CFG, n)).join(',') || 'NONE' });
});
