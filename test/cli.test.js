'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { spawnSync } = require('child_process');
const { mockProvider, setup, cli, cliAsync, SRC } = require('./helpers');

const LANES = { edit: [['a', 'model-a']], plan: [['a', 'model-a']] };

test('version, help and unknown commands', async () => {
  const s = await setup({ a: { url: 'http://127.0.0.1:1', keyEnv: 'A_KEY' } }, LANES);
  assert.match(cli(['version'], s.env).stdout, /^ag 1\.0\.0/);
  assert.match(cli(['--version'], s.env).stdout, /^ag 1\.0\.0/);
  const h = cli(['help'], s.env);
  assert.strictEqual(h.status, 0);
  for (const w of ['chat', 'doctor', 'router', 'undo', 'config']) assert.match(h.stdout, new RegExp(w));
  assert.match(cli(['help', 'undo'], s.env).stdout, /restore a file/);
  const bad = cli(['nonsense'], s.env);
  assert.strictEqual(bad.status, 1);
  assert.match(bad.stdout, /unknown command/);
});

test('first run creates the data folder and a default config', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-first-'));
  const env = { ...process.env, AG_HOME: path.join(home, 'data'), NO_COLOR: '1' };
  const r = cli(['config', 'path'], env);
  assert.strictEqual(r.status, 0);
  const cfg = JSON.parse(fs.readFileSync(path.join(home, 'data', 'config.json'), 'utf8'));
  assert.strictEqual(cfg.defaultLane, 'edit');
  assert.deepStrictEqual(cfg.lanes.edit[0], ['groq', 'openai/gpt-oss-120b']);
  assert.ok(!JSON.stringify(cfg.lanes.edit).includes('qwen'), 'qwen was removed from the edit lane');
});

test('doctor reports a healthy setup against a mock provider', async t => {
  const a = await mockProvider(() => null);
  t.after(() => a.close());
  const s = await setup({ a: { url: a.url, keyEnv: 'A_KEY' } }, LANES);
  const r = await cliAsync(['doctor'], s.env);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /A_KEY is set/);
  assert.match(r.stdout, /a reachable, key accepted/);
  assert.match(r.stdout, /router is not running/);
  assert.match(r.stdout, /0 problems/);
});

test('doctor flags a missing key and a rejected key', async t => {
  const a = await mockProvider(() => null);
  t.after(() => a.close());
  const s = await setup({ a: { url: a.url, keyEnv: 'A_KEY' } }, LANES);
  const missing = await cliAsync(['doctor'], { ...s.env, A_KEY: '' });
  assert.match(missing.stdout, /A_KEY is not set/);
  const quoted = await cliAsync(['doctor'], { ...s.env, A_KEY: '"abc"' });
  assert.match(quoted.stdout, /stray quotes/);
});

test('doctor shows a provider rejecting the key', async t => {
  const a = await mockProvider(() => null);
  a.server.removeAllListeners('request');
  a.server.on('request', (req, res) => { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end('{"error":"invalid key"}'); });
  t.after(() => a.close());
  const s = await setup({ a: { url: a.url, keyEnv: 'A_KEY' } }, LANES);
  const r = await cliAsync(['doctor'], s.env);
  assert.strictEqual(r.status, 1);
  assert.match(r.stdout, /HTTP 401/);
  assert.match(r.stdout, /the key was rejected/);
});

test('doctor reports a broken config instead of crashing', async () => {
  const s = await setup({ a: { url: 'http://127.0.0.1:1', keyEnv: 'A_KEY' } }, LANES);
  fs.writeFileSync(path.join(s.home, 'config.json'), '{ not json');
  const r = cli(['doctor'], s.env);
  assert.strictEqual(r.status, 1);
  assert.match(r.stdout, /not valid JSON/);
  const other = cli(['stats'], s.env);
  assert.strictEqual(other.status, 1);
  assert.match(other.stdout, /ag config edit/);
});

test('config validation catches bad lanes and providers', async () => {
  const G = require(path.join(SRC, 'common.js'));
  const issues = G.validateConfig({ defaultLane: 'x', providers: { p: { url: 'u' } }, lanes: { x: [['nope', 'm']], y: [] } });
  assert.ok(issues.some(i => /missing "keyEnv"/.test(i)));
  assert.ok(issues.some(i => /unknown provider "nope"/.test(i)));
  assert.ok(issues.some(i => /lane y: must be a non-empty list/.test(i)));
});

test('router start / health / stop lifecycle through the CLI', async t => {
  const a = await mockProvider(() => null);
  const s = await setup({ a: { url: a.url, keyEnv: 'A_KEY' } }, LANES);
  t.after(async () => { await cliAsync(['router', 'stop'], s.env); await a.close(); });
  assert.strictEqual(cli(['health'], s.env).status, 1);
  const start = cli(['router', 'start'], s.env);
  assert.strictEqual(start.status, 0, start.stdout + start.stderr);
  assert.match(start.stdout, /started/);
  assert.match(cli(['router', 'start'], s.env).stdout, /already running/);
  const h = cli(['health', '--json'], s.env);
  assert.strictEqual(JSON.parse(h.stdout).status, 'ok');
  const deep = await cliAsync(['health', '--deep'], s.env);
  assert.match(deep.stdout, /Live probe\n\s+✓ a/);
  assert.match(cli(['logs', 'router'], s.env).stdout, /start/);
  assert.match(cli(['router', 'stop'], s.env).stdout, /stopped/);
  assert.strictEqual(cli(['health'], s.env).status, 1);
});

test('chat refuses to run without a terminal', async () => {
  const s = await setup({ a: { url: 'http://127.0.0.1:1', keyEnv: 'A_KEY' } }, LANES);
  const r = cli(['chat'], s.env, { input: '' });
  assert.strictEqual(r.status, 1);
  assert.match(r.stdout, /interactive terminal/);
});

test('sessions, changes and undo work on an empty history', async () => {
  const s = await setup({ a: { url: 'http://127.0.0.1:1', keyEnv: 'A_KEY' } }, LANES);
  assert.match(cli(['sessions'], s.env).stdout, /no saved sessions/);
  assert.match(cli(['changes'], s.env).stdout, /no changes recorded/);
  const u = cli(['undo'], s.env, { cwd: os.tmpdir() });
  assert.strictEqual(u.status, 1);
  assert.match(u.stdout, /nothing to undo/);
  assert.strictEqual(cli(['show', 'nope'], s.env).status, 1);
});

test('undo restores a backed-up file and refuses when the file changed since', async () => {
  const s = await setup({ a: { url: 'http://127.0.0.1:1', keyEnv: 'A_KEY' } }, LANES);
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-proj-'));
  const file = path.join(proj, 'x.txt');
  const backup = path.join(s.home, 'backups', 'sess', '1-x.txt');
  fs.mkdirSync(path.dirname(backup), { recursive: true });
  fs.writeFileSync(backup, 'old');
  fs.writeFileSync(file, 'new');
  const sha = require('crypto').createHash('sha1').update('new').digest('hex');
  fs.writeFileSync(path.join(s.home, 'changes.jsonl'), JSON.stringify({ id: 1, ts: new Date().toISOString(), action: 'edit', status: 'applied', path: 'x.txt', abs: file, cwd: proj, backup, sha_after: sha, added: 1, removed: 1 }) + '\n');

  fs.writeFileSync(file, 'someone edited this');
  const refused = cli(['undo'], s.env, { cwd: proj, input: 'y\n' });
  assert.strictEqual(refused.status, 1);
  assert.match(refused.stdout, /changed since then/);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'someone edited this');

  const forced = cli(['undo', '--force'], s.env, { cwd: proj, input: 'y\n' });
  assert.strictEqual(forced.status, 0, forced.stdout);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'old');
  assert.match(cli(['changes'], s.env).stdout, /undone/);
});
