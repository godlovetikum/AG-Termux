'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { spawnSync } = require('child_process');

const INSTALL = path.join(__dirname, '..', 'install.js');
const run = (args, home, extra = {}) => spawnSync(process.execPath, [INSTALL, ...args], {
  env: { ...process.env, HOME: home, PREFIX: '', TERMUX_VERSION: '', NO_COLOR: '1', ...extra }, encoding: 'utf8',
});
const fresh = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ag-home-'));

test('dry run changes nothing', () => {
  const home = fresh();
  const r = run(['--dry-run'], home);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /DRY RUN/);
  assert.deepStrictEqual(fs.readdirSync(home), []);
});

test('installs program, launcher, keys template and shell hook', () => {
  const home = fresh();
  const r = run([], home);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  for (const f of ['common.js', 'router.js', 'ag.js']) assert.ok(fs.existsSync(path.join(home, 'ag', f)), f);
  const launcher = path.join(home, '.local', 'bin', 'ag');
  assert.ok(fs.existsSync(launcher));
  assert.ok(fs.statSync(launcher).mode & 0o100, 'launcher is executable');
  assert.strictEqual(fs.statSync(path.join(home, '.keys')).mode & 0o777, 0o600);
  assert.match(fs.readFileSync(path.join(home, '.bashrc'), 'utf8'), /source ~\/\.keys/);
  // the installed launcher actually runs
  const v = spawnSync(launcher, ['version'], { env: { ...process.env, HOME: home, AG_HOME: path.join(home, '.ag') }, encoding: 'utf8' });
  assert.match(v.stdout, /^ag 1\.0\.0/);
});

test('is idempotent and never overwrites existing keys or config', () => {
  const home = fresh();
  fs.writeFileSync(path.join(home, '.keys'), 'export GROQ_API_KEY="real"\n');
  fs.mkdirSync(path.join(home, '.ag'));
  fs.writeFileSync(path.join(home, '.ag', 'config.json'), '{"mine":true}');
  run([], home); run([], home);
  assert.strictEqual(fs.readFileSync(path.join(home, '.keys'), 'utf8'), 'export GROQ_API_KEY="real"\n');
  assert.strictEqual(fs.readFileSync(path.join(home, '.ag', 'config.json'), 'utf8'), '{"mine":true}');
  const rc = fs.readFileSync(path.join(home, '.bashrc'), 'utf8');
  assert.strictEqual(rc.split('\n').filter(l => /\.keys/.test(l)).length, 1, 'only one source line');
});

test('replaces the old alias line and keeps unrelated bashrc content', () => {
  const home = fresh();
  fs.writeFileSync(path.join(home, '.bashrc'), "export FOO=1\nalias ag='node ~/ag/ag.js'\nsource ~/.keys\n");
  run([], home);
  const rc = fs.readFileSync(path.join(home, '.bashrc'), 'utf8');
  assert.doesNotMatch(rc, /alias ag=/);
  assert.match(rc, /export FOO=1/);
});

test('--no-shell and --no-keys leave those files alone', () => {
  const home = fresh();
  run(['--no-shell', '--no-keys'], home);
  assert.ok(!fs.existsSync(path.join(home, '.bashrc')));
  assert.ok(!fs.existsSync(path.join(home, '.keys')));
});

test('Termux layout: launcher goes in $PREFIX/bin', () => {
  const home = fresh(), prefix = path.join(home, 'usr');
  fs.mkdirSync(path.join(prefix, 'bin'), { recursive: true });
  const r = run([], home, { PREFIX: prefix, TERMUX_VERSION: '0.118' });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Termux detected/);
  const launcher = path.join(prefix, 'bin', 'ag');
  assert.ok(fs.existsSync(launcher));
  assert.match(fs.readFileSync(launcher, 'utf8'), new RegExp('^#!' + prefix.replace(/[/.]/g, '\\$&') + '/bin/sh'));
});

test('uninstall removes the program but keeps data unless --purge', () => {
  const home = fresh();
  run([], home);
  fs.mkdirSync(path.join(home, '.ag'));
  fs.writeFileSync(path.join(home, '.ag', 'config.json'), '{}');
  run(['--uninstall'], home);
  assert.ok(!fs.existsSync(path.join(home, 'ag')));
  assert.ok(!fs.existsSync(path.join(home, '.local', 'bin', 'ag')));
  assert.ok(fs.existsSync(path.join(home, '.ag', 'config.json')));
  assert.ok(fs.existsSync(path.join(home, '.keys')), 'keys are never removed');
  run(['--uninstall', '--purge'], home, { AG_HOME: '' });
  assert.ok(!fs.existsSync(path.join(home, '.ag')));
});

test('bootstrap refuses the placeholder repo and passes syntax checks', () => {
  const b = path.join(__dirname, '..', 'scripts', 'bootstrap.js');
  const r = spawnSync(process.execPath, [b], { encoding: 'utf8', env: { ...process.env, AG_REPO: 'OWNER/ag-termux' } });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /placeholder repo/);
});
