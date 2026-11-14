'use strict';
// API keys can come from the environment or from a private keys file (keys.env in the data
// folder). The environment always wins. The file works the same on every OS, with no shell setup.
const fs = require('fs');
const { P } = require('./common');

const SOURCE = {}; // VARIABLE_NAME -> 'keys file', for values this module loaded

function parse(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    const q = v[0];
    if ((q === '"' || q === "'") && v.indexOf(q, 1) > 0) v = v.slice(1, v.indexOf(q, 1));
    else v = v.replace(/\s+#.*$/, '');
    out[m[1]] = v;
  }
  return out;
}

function readFile() { try { return parse(fs.readFileSync(P.keys, 'utf8')); } catch { return {}; } }

function loadKeys() {
  const vals = readFile();
  for (const [k, v] of Object.entries(vals)) {
    if (v && !process.env[k]) { process.env[k] = v; SOURCE[k] = 'keys file'; }
  }
  return vals;
}

function lines() { try { return fs.readFileSync(P.keys, 'utf8').split(/\r?\n/); } catch { return null; } }

function write(ls) {
  fs.mkdirSync(P.home, { recursive: true, mode: 0o700 });
  fs.writeFileSync(P.keys, ls.join('\n').replace(/\n*$/, '\n'), { mode: 0o600 });
  try { fs.chmodSync(P.keys, 0o600); } catch {}
}

const dropVar = (ls, name) => ls.filter(l => { const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(l); return !(m && m[1] === name); });

function saveKey(name, value) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`"${name}" is not a valid variable name`);
  value = String(value).trim();
  if (!value) throw new Error('the key is empty');
  if (/[\s"'\\]/.test(value)) throw new Error('keys cannot contain spaces, quotes or backslashes (was something extra pasted?)');
  const ls = dropVar(lines() || ['# agt API keys. One NAME="value" per line. Keep this file private.'], name);
  ls.push(`${name}="${value}"`);
  write(ls);
}

function removeKey(name) {
  const ls = lines();
  if (!ls) return false;
  const next = dropVar(ls, name);
  if (next.length === ls.length) return false;
  write(next);
  return true;
}

module.exports = { parse, readFile, loadKeys, saveKey, removeKey, SOURCE };
