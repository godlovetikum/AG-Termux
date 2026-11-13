#!/usr/bin/env node
'use strict';
/*
 * One-step installer for Termux. It downloads the repo files from GitHub into a temp
 * folder, checks them, and runs install.js. Zero dependencies (Node 18+ built-in fetch).
 *
 *   curl -fsSL https://raw.githubusercontent.com/godlovetikum/ag-termux/main/scripts/bootstrap.js | node -
 *
 * Extra arguments go to install.js:   ... | node - --doctor
 * Settings (environment variables):
 *   AG_REPO   owner/name   default: godlovetikum/ag-termux   (set this if you forked the repo)
 *   AG_REF    branch/tag   default: main
 */
const fs = require('fs'), path = require('path'), os = require('os'), vm = require('vm');
const { spawnSync } = require('child_process');

const REPO = process.env.AG_REPO || 'godlovetikum/ag-termux';
const REF = process.env.AG_REF || 'main';
const FILES = ['install.js', 'package.json', 'src/common.js', 'src/router.js', 'src/ag.js'];

(async () => {
  if (Number(process.versions.node.split('.')[0]) < 18) { console.error('Node 18+ is required. Run: pkg upgrade nodejs'); process.exit(1); }
  if (REPO.startsWith('OWNER/')) {
    console.error('This copy of bootstrap.js still has the placeholder repo "OWNER/ag-termux".\nRun it as:  AG_REPO=<your-github-name>/ag-termux node scripts/bootstrap.js\nor use the zip route: unzip, then  node install.js');
    process.exit(1);
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-install-'));
  console.log(`Downloading ${REPO}@${REF} ...`);
  try {
    for (const f of FILES) {
      const url = `https://raw.githubusercontent.com/${REPO}/${REF}/${f}`;
      const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
      const text = await r.text();
      if (!text.trim()) throw new Error(`${f} downloaded empty`);
      if (f.endsWith('.js')) { try { new vm.Script(text.replace(/^#!.*/, ''), { filename: f }); } catch (e) { throw new Error(`${f} is not valid JavaScript: ${e.message}`); } }
      fs.mkdirSync(path.dirname(path.join(tmp, f)), { recursive: true });
      fs.writeFileSync(path.join(tmp, f), text);
    }
  } catch (e) {
    console.error('Download failed: ' + e.message + '\nCheck your connection and the repo name, or use the zip route instead.');
    process.exit(1);
  }
  console.log('Files verified. Running the installer...\n');
  const args = process.argv.slice(2); // works for both `node bootstrap.js ...` and `... | node - ...`
  const r = spawnSync(process.execPath, [path.join(tmp, 'install.js'), ...args], { stdio: 'inherit' });
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  process.exit(r.status === null ? 1 : r.status);
})();
