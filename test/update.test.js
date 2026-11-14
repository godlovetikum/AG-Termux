'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { setup, cliAsync } = require('./helpers');
const VERSION = require('../package.json').version;

function registry(version) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(req.url);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ name: 'agt-cli', version }));
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ seen, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(x => server.close(x)) })));
}
const withoutSkip = env => { const e = { ...env }; delete e.AGT_NO_UPDATE_CHECK; return e; };
const LANES = { edit: [['a', 'm']] };

test('agt update --check reports a newer version', async t => {
  const reg = await registry('99.0.0');
  t.after(() => reg.close());
  const s = await setup({ a: { url: 'http://127.0.0.1:1', keyEnv: 'A_KEY' } }, LANES);
  const r = await cliAsync(['update', '--check'], { ...s.env, AGT_REGISTRY: reg.url });
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, new RegExp(`installed ${VERSION.replace(/\./g, '\\.')} · latest 99\\.0\\.0`));
  assert.match(r.stdout, /update available: 99\.0\.0/);
  assert.deepStrictEqual(reg.seen, ['/agt-cli/latest']);
});

test('agt update says so when already current, and when this copy is not an npm install', async t => {
  const same = await registry(VERSION);
  const newer = await registry('99.0.0');
  t.after(() => Promise.all([same.close(), newer.close()]));
  const s = await setup({ a: { url: 'http://127.0.0.1:1', keyEnv: 'A_KEY' } }, LANES);
  assert.match((await cliAsync(['update'], { ...s.env, AGT_REGISTRY: same.url })).stdout, /already up to date/);
  const r = await cliAsync(['update'], { ...s.env, AGT_REGISTRY: newer.url });
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /not installed with npm/);
  assert.match(r.stdout, /npm install -g agt-cli@latest/);
});

test('agt update fails clearly when the registry cannot be reached', async () => {
  const s = await setup({ a: { url: 'http://127.0.0.1:1', keyEnv: 'A_KEY' } }, LANES);
  const r = await cliAsync(['update', '--check'], { ...s.env, AGT_REGISTRY: 'http://127.0.0.1:1' });
  assert.strictEqual(r.status, 1);
  assert.match(r.stdout, /latest unknown/);
});

test('doctor mentions an available update, and stays quiet about failures when offline', async t => {
  const reg = await registry('99.0.0');
  t.after(() => reg.close());
  const s = await setup({ a: { url: 'http://127.0.0.1:1', keyEnv: 'A_KEY' } }, LANES);
  const env = withoutSkip({ ...s.env, A_KEY: '' });
  const up = await cliAsync(['doctor'], { ...env, AGT_REGISTRY: reg.url });
  assert.match(up.stdout, /update available: 99\.0\.0/);
  assert.match(up.stdout, /agt update/);
  const off = await cliAsync(['doctor'], { ...env, AGT_REGISTRY: 'http://127.0.0.1:1' });
  assert.ok(!/update available|up to date/.test(off.stdout), 'no update line when the check cannot run');
});
