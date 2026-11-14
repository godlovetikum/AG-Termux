'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { mockProvider, setup, startRouter, waitUp, post, cli, cliAsync } = require('./helpers');
const G = require('../src/common');

const ok = text => [200, { choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }] }];

test('resolveTarget: lanes, aliases and provider/model pairs', () => {
  const cfg = {
    providers: { groq: { url: 'u', keyEnv: 'K' }, gemini: { url: 'u', keyEnv: 'G' } },
    lanes: { edit: [['groq', 'm1']], plan: [['gemini', 'm2']] },
    aliases: { fast: 'groq/openai/gpt-oss-120b', planner: 'plan' },
  };
  assert.deepStrictEqual(G.resolveTarget(cfg, 'edit'), { type: 'lane', label: 'edit', steps: [['groq', 'm1']] });
  const pin = G.resolveTarget(cfg, 'groq/openai/gpt-oss-120b');
  assert.strictEqual(pin.type, 'model');
  assert.deepStrictEqual(pin.steps, [['groq', 'openai/gpt-oss-120b']]);
  assert.strictEqual(G.resolveTarget(cfg, 'fast').label, 'fast (groq/openai/gpt-oss-120b)');
  assert.strictEqual(G.resolveTarget(cfg, 'planner').type, 'lane');
  assert.strictEqual(G.resolveTarget(cfg, 'nothere/model'), null);
  assert.strictEqual(G.resolveTarget(cfg, 'groq/'), null);
  assert.strictEqual(G.resolveTarget(cfg, ''), null);
});

test('alias problems are reported by config validation', () => {
  const issues = G.validateConfig({ defaultLane: 'edit', providers: { a: { url: 'u', keyEnv: 'K' } }, lanes: { edit: [['a', 'm']] }, aliases: { edit: 'a/x', bad: 'zzz/q' } });
  assert.ok(issues.some(i => /alias "edit" has the same name as a lane/.test(i)));
  assert.ok(issues.some(i => /alias "bad".*not a lane or a provider\/model/.test(i)));
});

test('router: a pinned provider/model is used exactly, with no failover', async t => {
  const a = await mockProvider(() => ok('from-a'));
  const b = await mockProvider(() => ok('from-b'));
  t.after(() => Promise.all([a.close(), b.close()]));
  const s = await setup({ a: { url: a.url, keyEnv: 'A_KEY' }, b: { url: b.url, keyEnv: 'B_KEY' } }, { edit: [['a', 'lane-model']] }, { aliases: { other: 'b/special-model' } });
  const child = startRouter(s.env);
  t.after(() => child.kill());
  await waitUp(s.base);

  const lane = await (await post(s.base, { model: 'edit', messages: [] })).json();
  assert.strictEqual(lane.choices[0].message.content, 'from-a');

  const pinned = await post(s.base, { model: 'b/some/deep-model-id', messages: [] });
  assert.strictEqual(pinned.headers.get('x-router-via'), 'b/some/deep-model-id');
  assert.strictEqual((await pinned.json()).choices[0].message.content, 'from-b');
  assert.strictEqual(b.seen.at(-1).body.model, 'some/deep-model-id', 'only the part after the provider is sent upstream');

  const alias = await post(s.base, { model: 'other', messages: [] });
  assert.strictEqual(alias.headers.get('x-router-via'), 'b/special-model');
  assert.strictEqual(b.seen.at(-1).body.model, 'special-model');
});

test('router: a failing pinned model errors instead of silently using another model', async t => {
  const a = await mockProvider(() => [500, { error: 'boom' }]);
  const b = await mockProvider(() => ok('from-b'));
  t.after(() => Promise.all([a.close(), b.close()]));
  const s = await setup({ a: { url: a.url, keyEnv: 'A_KEY' }, b: { url: b.url, keyEnv: 'B_KEY' } }, { edit: [['a', 'x'], ['b', 'y']] });
  const child = startRouter(s.env);
  t.after(() => child.kill());
  await waitUp(s.base);

  assert.strictEqual((await post(s.base, { model: 'edit', messages: [] })).status, 200, 'the lane fails over to b');
  const pinned = await post(s.base, { model: 'a/x', messages: [] });
  assert.strictEqual(pinned.status, 503, 'the pin does not fail over');
  assert.strictEqual((await pinned.json()).error.attempts.length, 1);
  assert.strictEqual(b.seen.filter(x => x.url.endsWith('/chat/completions')).length, 1, 'b only served the lane request');
});

test('router: a pinned model whose provider has no key explains what to set', async t => {
  const s = await setup({ a: { url: 'http://127.0.0.1:1', keyEnv: 'A_KEY' } }, { edit: [['a', 'x']] });
  const child = startRouter({ ...s.env, A_KEY: '' });
  t.after(() => child.kill());
  await waitUp(s.base);
  const r = await post(s.base, { model: 'a/x', messages: [] });
  assert.strictEqual(r.status, 503);
  assert.match((await r.json()).error.message, /Set: A_KEY/);
});

test('agt models lists lanes, aliases and providers; --live lists model ids as pasteable pins', async t => {
  const a = await mockProvider(() => null, ['models/zeta-1', 'alpha-2']);
  t.after(() => a.close());
  const s = await setup({ a: { url: a.url, keyEnv: 'A_KEY' } }, { edit: [['a', 'alpha-2']] }, { aliases: { quick: 'a/alpha-2' } });
  const plain = cli(['models'], s.env);
  assert.match(plain.stdout, /edit: a\/alpha-2/);
  assert.match(plain.stdout, /quick = a\/alpha-2/);
  assert.ok(!plain.stdout.includes('zeta-1'));
  const live = await cliAsync(['models', '--live'], s.env);
  assert.match(live.stdout, /\n\s+a\/alpha-2\n\s+a\/zeta-1\n/, 'sorted, with the models/ prefix removed');
  const none = await cliAsync(['models', 'nope'], s.env);
  assert.match(none.stdout, /no provider named "nope"/);
});

test('chat --model rejects unknown names before doing anything', async () => {
  const s = await setup({ a: { url: 'http://127.0.0.1:1', keyEnv: 'A_KEY' } }, { edit: [['a', 'x']] });
  // chat needs a terminal, so the unknown-model check is covered in the pty test; here we only
  // confirm the flag is parsed as a value (not as the first chat message).
  const r = cli(['chat', '--model', 'zzz/none'], s.env, { input: '' });
  assert.strictEqual(r.status, 1);
  assert.match(r.stdout, /interactive terminal/);
});
