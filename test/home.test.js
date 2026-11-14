'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { spawnSync } = require('child_process');

const COMMON = path.join(__dirname, '..', 'src', 'common.js');
function dataFolder(home, extraEnv = {}) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, ...extraEnv };
  delete env.AGT_HOME; delete env.AG_HOME;
  Object.assign(env, extraEnv);
  const r = spawnSync(process.execPath, ['-e', `console.log(require(${JSON.stringify(COMMON)}).P.home)`], { env, encoding: 'utf8' });
  return r.stdout.trim();
}
const tmpHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agt-home-'));

test('default data folder is ~/.agt', () => {
  const h = tmpHome();
  assert.strictEqual(dataFolder(h), path.join(h, '.agt'));
});

test('an existing ~/.ag from the earlier version keeps being used', () => {
  const h = tmpHome();
  fs.mkdirSync(path.join(h, '.ag'));
  assert.strictEqual(dataFolder(h), path.join(h, '.ag'));
  fs.mkdirSync(path.join(h, '.agt'));
  assert.strictEqual(dataFolder(h), path.join(h, '.agt'), '~/.agt wins once it exists');
});

test('AGT_HOME wins, and the old AG_HOME name still works', () => {
  const h = tmpHome();
  assert.strictEqual(dataFolder(h, { AGT_HOME: '/x/new' }), '/x/new');
  assert.strictEqual(dataFolder(h, { AG_HOME: '/x/old' }), '/x/old');
  assert.strictEqual(dataFolder(h, { AGT_HOME: '/x/new', AG_HOME: '/x/old' }), '/x/new');
});
