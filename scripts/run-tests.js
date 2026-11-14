'use strict';
// Runs every test/*.test.js with Node's built-in test runner. Written in JS (not a shell glob)
// so `npm test` behaves the same on Windows, macOS and Linux.
const fs = require('fs'), path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const files = fs.readdirSync(path.join(root, 'test')).filter(f => f.endsWith('.test.js')).sort().map(f => path.join('test', f));
const r = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit', cwd: root });
process.exit(r.status === null ? 1 : r.status);
