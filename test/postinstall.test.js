'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SHEBANG = '#!/usr/bin/env node';

// A throwaway copy of the package layout, so the real files are never touched.
function fakePackage() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agt-post-'));
  fs.mkdirSync(path.join(dir, 'bin')); fs.mkdirSync(path.join(dir, 'scripts'));
  fs.copyFileSync(path.join(ROOT, 'bin', 'agt.js'), path.join(dir, 'bin', 'agt.js'));
  fs.copyFileSync(path.join(ROOT, 'scripts', 'postinstall.js'), path.join(dir, 'scripts', 'postinstall.js'));
  return dir;
}
const run = (dir, env) => spawnSync(process.execPath, [path.join(dir, 'scripts', 'postinstall.js')], { env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' });
const firstLine = dir => fs.readFileSync(path.join(dir, 'bin', 'agt.js'), 'utf8').split('\n', 1)[0];

test('the shipped launcher uses the portable shebang', () => {
  assert.strictEqual(firstLine(ROOT), SHEBANG);
});

test('Termux: points the launcher at the prefix env, and is idempotent', () => {
  const dir = fakePackage();
  const prefix = path.join(dir, 'com.termux', 'usr');
  fs.mkdirSync(path.join(prefix, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(prefix, 'bin', 'env'), '');
  const r = run(dir, { PREFIX: prefix });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(firstLine(dir), `#!${path.join(prefix, 'bin', 'env')} node`);
  const before = fs.readFileSync(path.join(dir, 'bin', 'agt.js'), 'utf8');
  run(dir, { PREFIX: prefix });
  assert.strictEqual(fs.readFileSync(path.join(dir, 'bin', 'agt.js'), 'utf8'), before, 'second run changes nothing');
  assert.match(before, /require\('\.\.\/src\/cli\.js'\)/, 'the rest of the file is intact');
});

test('Termux without a prefix env falls back to the running node', () => {
  const dir = fakePackage();
  const prefix = path.join(dir, 'com.termux', 'usr');
  fs.mkdirSync(prefix, { recursive: true });
  assert.strictEqual(run(dir, { PREFIX: prefix }).status, 0);
  assert.strictEqual(firstLine(dir), `#!${process.execPath}`);
});

test('other systems are left alone', () => {
  const dir = fakePackage();
  assert.strictEqual(run(dir, { PREFIX: '/usr/local' }).status, 0);
  assert.strictEqual(firstLine(dir), SHEBANG);
  assert.strictEqual(run(dir, {}).status, 0);
  assert.strictEqual(firstLine(dir), SHEBANG);
});

test('a missing launcher never fails the install', () => {
  const dir = fakePackage();
  fs.rmSync(path.join(dir, 'bin', 'agt.js'));
  const r = run(dir, { TERMUX_VERSION: '0.118' });
  assert.strictEqual(r.status, 0);
});
