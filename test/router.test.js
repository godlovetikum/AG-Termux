'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { mockProvider, setup, startRouter, waitUp, post } = require('./helpers');

const OK = (text = 'ok') => [200, { choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }] }];

async function withRouter(t, handlers, lanes, extra) {
  const a = await mockProvider(handlers.a), b = await mockProvider(handlers.b || (() => OK('from-b')));
  const s = await setup(
    { a: { url: a.url, keyEnv: 'A_KEY', ...(handlers.aOpts || {}) }, b: { url: b.url, keyEnv: 'B_KEY' } },
    lanes || { edit: [['a', 'model-a'], ['b', 'model-b']] }, extra);
  const child = startRouter(s.env);
  await waitUp(s.base);
  t.after(async () => { child.kill('SIGTERM'); await a.close(); await b.close(); });
  return { a, b, s };
}

test('routes to the first provider and swaps in the real model id', async t => {
  const { a, s } = await withRouter(t, { a: () => OK('from-a') });
  const r = await post(s.base, { model: 'edit', messages: [{ role: 'user', content: 'hi' }] });
  assert.strictEqual(r.status, 200);
  assert.strictEqual((await r.json()).choices[0].message.content, 'from-a');
  assert.strictEqual(r.headers.get('x-router-via'), 'a/model-a');
  assert.strictEqual(a.seen[0].body.model, 'model-a');
  assert.strictEqual(a.seen[0].auth, 'Bearer key-a');
});

test('falls back to the next provider on 500 and parks the failed one', async t => {
  const { a, s } = await withRouter(t, { a: () => [500, { error: 'boom' }] });
  const r = await post(s.base, { model: 'edit', messages: [] });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.headers.get('x-router-via'), 'b/model-b');
  assert.strictEqual(r.headers.get('x-router-attempts'), '2');
  const h = await (await fetch(s.base + '/health')).json();
  assert.ok(h.cooling['a/model-a'] > 0, 'a is parked');
  assert.strictEqual(h.status, 'degraded');
  // second request skips the parked provider entirely
  const before = a.seen.length;
  await post(s.base, { model: 'edit', messages: [] });
  assert.strictEqual(a.seen.length, before);
});

test('429 with a short retry hint waits and retries the same provider once', async t => {
  let n = 0;
  const { a, s } = await withRouter(t, {
    a: () => (++n === 1 ? [429, { error: { message: 'Please try again in 200ms.' } }] : OK('retried')),
  });
  const r = await post(s.base, { model: 'edit', messages: [] });
  assert.strictEqual(r.headers.get('x-router-via'), 'a/model-a');
  assert.strictEqual((await r.json()).choices[0].message.content, 'retried');
  assert.strictEqual(a.seen.length, 2);
});

test('429 with a long retry-after parks the provider and falls back', async t => {
  const { s } = await withRouter(t, { a: () => [429, { error: 'slow down' }, { 'retry-after': '120' }] });
  const r = await post(s.base, { model: 'edit', messages: [] });
  assert.strictEqual(r.headers.get('x-router-via'), 'b/model-b');
  const h = await (await fetch(s.base + '/health')).json();
  assert.ok(h.cooling['a/model-a'] > 100);
});

test('503 with every attempt listed when all providers fail', async t => {
  const { s } = await withRouter(t, { a: () => [500, { error: 'a down' }], b: () => [401, { error: 'b bad key' }] });
  const r = await post(s.base, { model: 'edit', messages: [] });
  assert.strictEqual(r.status, 503);
  const j = await r.json();
  assert.strictEqual(j.error.attempts.length, 2);
  assert.match(j.error.attempts[1].error, /bad key/);
});

test('unknown lane name uses the default lane', async t => {
  const { s } = await withRouter(t, { a: () => OK('from-a') });
  const r = await post(s.base, { model: 'gpt-4', messages: [] });
  assert.strictEqual(r.headers.get('x-router-lane'), 'edit');
});

test('strips reasoning and Gemini fields for non-Gemini providers', async t => {
  const { a, s } = await withRouter(t, { a: () => OK() });
  await post(s.base, {
    model: 'edit',
    messages: [{ role: 'assistant', reasoning: 'x', content: 'c', tool_calls: [{ id: '1', type: 'function', extra_content: { google: { thought_signature: 'sig' } }, function: { name: 'f', arguments: '{}' } }] }],
  });
  const m = a.seen[0].body.messages[0];
  assert.strictEqual(m.reasoning, undefined);
  assert.strictEqual(m.tool_calls[0].extra_content, undefined);
});

test('adds the dummy thought_signature for Gemini-style providers when it is missing', async t => {
  const { a, s } = await withRouter(t, { a: () => OK(), aOpts: { keepGeminiFields: true } });
  await post(s.base, {
    model: 'edit',
    messages: [{ role: 'assistant', tool_calls: [
      { id: '1', type: 'function', function: { name: 'f', arguments: '{}' } },
      { id: '2', type: 'function', extra_content: { google: { thought_signature: 'real' } }, function: { name: 'f', arguments: '{}' } },
    ] }],
  });
  const tcs = a.seen[0].body.messages[0].tool_calls;
  assert.strictEqual(tcs[0].extra_content.google.thought_signature, 'skip_thought_signature_validator');
  assert.strictEqual(tcs[1].extra_content.google.thought_signature, 'real');
});

test('lane with no configured key returns a clear 503', async t => {
  const { s } = await withRouter(t, { a: () => OK() }, { edit: [['a', 'model-a']] });
  // a second router without the key
  const { spawn } = require('child_process');
  const env = { ...s.env, A_KEY: '' };
  const { freePort } = require('./helpers');
  void freePort;
  const cfg = JSON.parse(require('fs').readFileSync(s.home + '/config.json', 'utf8'));
  cfg.port = s.port + 1;
  require('fs').writeFileSync(s.home + '/config.json', JSON.stringify(cfg));
  const child = spawn(process.execPath, [require('path').join(__dirname, '..', 'src', 'router.js')], { env, stdio: 'ignore' });
  t.after(() => child.kill('SIGTERM'));
  await waitUp(`http://127.0.0.1:${s.port + 1}`);
  const r = await post(`http://127.0.0.1:${s.port + 1}`, { model: 'edit', messages: [] });
  assert.strictEqual(r.status, 503);
  assert.match((await r.json()).error.message, /A_KEY/);
});

test('rejects foreign Host headers and non-JSON posts', async t => {
  const { s } = await withRouter(t, { a: () => OK() });
  const http = require('http');
  const status = await new Promise(res => {
    const q = http.request({ host: '127.0.0.1', port: s.port, path: '/health', headers: { Host: 'evil.example.com' } }, r => { r.resume(); res(r.statusCode); });
    q.end();
  });
  assert.strictEqual(status, 403);
  const r = await fetch(s.base + '/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'x' });
  assert.strictEqual(r.status, 415);
});

test('admin endpoints: reset clears cooldowns, shutdown stops the router', async t => {
  const { s } = await withRouter(t, { a: () => [500, {}] });
  await post(s.base, { model: 'edit', messages: [] });
  let h = await (await fetch(s.base + '/health')).json();
  assert.ok(Object.keys(h.cooling).length > 0);
  await fetch(s.base + '/admin/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  h = await (await fetch(s.base + '/health')).json();
  assert.strictEqual(Object.keys(h.cooling).length, 0);
  await fetch(s.base + '/admin/shutdown', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  await new Promise(r => setTimeout(r, 700));
  await assert.rejects(fetch(s.base + '/health'));
});

test('stats are counted per provider and persisted on shutdown', async t => {
  const { s } = await withRouter(t, { a: () => OK() });
  await post(s.base, { model: 'edit', messages: [] });
  const st = await (await fetch(s.base + '/stats')).json();
  assert.strictEqual(st.since_start['a/model-a'].ok, 1);
  await fetch(s.base + '/admin/shutdown', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  await new Promise(r => setTimeout(r, 700));
  const saved = JSON.parse(require('fs').readFileSync(s.home + '/router-stats.json', 'utf8'));
  assert.strictEqual(Object.values(saved.daily)[0]['a/model-a'].ok, 1);
});

test('health?deep=1 probes configured providers', async t => {
  const { s } = await withRouter(t, { a: () => OK() });
  const h = await (await fetch(s.base + '/health?deep=1')).json();
  assert.strictEqual(h.probes.length, 2);
  assert.ok(h.probes.every(p => p.ok));
});
