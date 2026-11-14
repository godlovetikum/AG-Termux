'use strict';
const fs = require('fs'), path = require('path'), os = require('os');

const VERSION = require('../package.json').version;
// Data folder: AGT_HOME (or the older AG_HOME) wins; otherwise ~/.agt, or the earlier ~/.ag when that
// is where your existing config and history already live.
const FRESH = path.join(os.homedir(), '.agt'), LEGACY = path.join(os.homedir(), '.ag');
const HOME = process.env.AGT_HOME || process.env.AG_HOME || (!fs.existsSync(FRESH) && fs.existsSync(LEGACY) ? LEGACY : FRESH);
const P = {
  home: HOME,
  config: path.join(HOME, 'config.json'),
  keys: path.join(HOME, 'keys.env'),
  pid: path.join(HOME, 'router.pid'),
  stats: path.join(HOME, 'router-stats.json'),
  logs: path.join(HOME, 'logs'),
  routerLog: path.join(HOME, 'logs', 'router.log'),
  routerOut: path.join(HOME, 'logs', 'router.out'),
  agentLog: path.join(HOME, 'logs', 'agent.log'),
  sessions: path.join(HOME, 'sessions'),
  backups: path.join(HOME, 'backups'),
  proposed: path.join(HOME, 'proposed'),
  changes: path.join(HOME, 'changes.jsonl'),
};

const DEFAULT_CONFIG = {
  port: 4000,
  defaultLane: 'edit',
  cooldownSec: 300,
  requestTimeoutSec: 120,
  commandTimeoutSec: 120,
  maxSteps: 25,
  maxToolChars: 30000,
  previewLines: 20,
  // Short names for pinning one exact model: /model fast  (see "agt models")
  aliases: {
    fast: 'groq/openai/gpt-oss-120b',
    big: 'gemini/gemini-3-flash-preview',
  },
  providers: {
    gemini: { url: 'https://generativelanguage.googleapis.com/v1beta/openai', keyEnv: 'GEMINI_API_KEY', keepGeminiFields: true },
    groq: { url: 'https://api.groq.com/openai/v1', keyEnv: 'GROQ_API_KEY' },
  },
  lanes: {
    plan: [['gemini', 'gemini-3-flash-preview'], ['groq', 'openai/gpt-oss-120b']],
    edit: [['groq', 'openai/gpt-oss-120b'], ['gemini', 'gemini-3-flash-preview']],
  },
};

// ---------- colors ----------
const TTY = !!process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (a, b) => s => (TTY ? `\x1b[${a}m${s}\x1b[${b}m` : String(s));
const c = { bold: wrap(1, 22), dim: wrap(2, 22), red: wrap(31, 39), green: wrap(32, 39), yellow: wrap(33, 39), blue: wrap(34, 39), cyan: wrap(36, 39) };
const sym = { ok: c.green('✓'), warn: c.yellow('!'), fail: c.red('✗'), info: c.cyan('•') };

// ---------- platform ----------
const isTermux = () => /com\.termux/.test(process.env.PREFIX || '') || !!process.env.TERMUX_VERSION;
const platformName = () => (isTermux() ? 'Android (Termux)' : { win32: 'Windows', darwin: 'macOS', linux: 'Linux' }[process.platform] || process.platform);
function installHint(pkg) {
  if (isTermux()) return `pkg install ${pkg}`;
  if (process.platform === 'win32') return pkg === 'git' ? 'winget install --id Git.Git' : `install ${pkg}`;
  if (process.platform === 'darwin') return `brew install ${pkg}`;
  return `install ${pkg} with your package manager (for example: sudo apt install ${pkg})`;
}

// ---------- formatting ----------
const dur = s => (s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`);
const bytes = n => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);
const ago = iso => {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso)) / 1000));
  return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`;
};
function formatLog(r) {
  const { ts, level, event, ...rest } = r;
  const lv = level === 'error' ? c.red('ERR') : level === 'warn' ? c.yellow('WRN') : level === 'debug' ? c.dim('dbg') : c.green('inf');
  const kv = Object.entries(rest).map(([k, v]) => `${c.dim(k + '=')}${v !== null && typeof v === 'object' ? JSON.stringify(v) : v}`).join(' ');
  return `${c.dim((ts || '').slice(11, 19))} ${lv} ${c.bold(event)} ${kv}`;
}

// ---------- files ----------
function ensureDirs() {
  for (const d of [P.home, P.logs, P.sessions, P.backups, P.proposed]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(P.home, 0o700); } catch {}
}
function appendJsonl(file, obj) { try { fs.appendFileSync(file, JSON.stringify(obj) + '\n'); } catch {} }
function readJsonl(file) {
  try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); }
  catch { return []; }
}
function tailFile(file, n) { try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-n); } catch { return []; } }
function rotate(file, max = 2e6) { try { if (fs.statSync(file).size > max) fs.renameSync(file, file + '.1'); } catch {} }

// ---------- config ----------
function loadConfig() {
  ensureDirs();
  if (!fs.existsSync(P.config)) fs.writeFileSync(P.config, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n');
  let user;
  try { user = JSON.parse(fs.readFileSync(P.config, 'utf8')); }
  catch (e) { throw new Error(`config is not valid JSON (${P.config}): ${e.message}`); }
  return { ...DEFAULT_CONFIG, ...user };
}
function validateConfig(cfg) {
  const issues = [];
  if (!cfg.providers || typeof cfg.providers !== 'object') return ['"providers" must be an object'];
  for (const [n, p] of Object.entries(cfg.providers)) {
    if (!p.url) issues.push(`provider ${n}: missing "url"`);
    if (!p.keyEnv) issues.push(`provider ${n}: missing "keyEnv"`);
  }
  for (const [ln, steps] of Object.entries(cfg.lanes || {})) {
    if (!Array.isArray(steps) || !steps.length) { issues.push(`lane ${ln}: must be a non-empty list`); continue; }
    steps.forEach((s, i) => {
      if (!Array.isArray(s) || s.length !== 2) issues.push(`lane ${ln} step ${i + 1}: must be ["provider", "model"]`);
      else if (!cfg.providers[s[0]]) issues.push(`lane ${ln}: unknown provider "${s[0]}"`);
    });
  }
  if (!(cfg.lanes && cfg.lanes[cfg.defaultLane])) issues.push(`defaultLane "${cfg.defaultLane}" is not a lane`);
  for (const [a, spec] of Object.entries(cfg.aliases || {})) {
    if (cfg.lanes && cfg.lanes[a]) issues.push(`alias "${a}" has the same name as a lane (the lane wins)`);
    if (!resolveTarget({ ...cfg, aliases: {} }, spec)) issues.push(`alias "${a}": "${spec}" is not a lane or a provider/model pair`);
  }
  return issues;
}
// What a name means: a lane (ordered failover list), an alias, or one exact "provider/model".
// A pinned model has no failover: only that model is tried.
function resolveTarget(cfg, name) {
  if (typeof name !== 'string' || !name) return null;
  if (cfg.lanes && cfg.lanes[name]) return { type: 'lane', label: name, steps: cfg.lanes[name] };
  const spec = (cfg.aliases && cfg.aliases[name]) || name;
  if (cfg.lanes && cfg.lanes[spec]) return { type: 'lane', label: name, steps: cfg.lanes[spec] };
  const i = spec.indexOf('/');
  if (i > 0 && i < spec.length - 1) {
    const p = spec.slice(0, i), m = spec.slice(i + 1);
    if (cfg.providers && cfg.providers[p]) return { type: 'model', label: name === spec ? spec : `${name} (${spec})`, steps: [[p, m]] };
  }
  return null;
}
function keyOf(cfg, name) {
  const p = cfg.providers[name];
  if (!p || !p.keyEnv) return undefined;
  const v = (process.env[p.keyEnv] || '').trim().replace(/^["']|["']$/g, '');
  return v || undefined;
}

// ---------- provider probe (lists models: costs no tokens) ----------
async function probeProvider(cfg, name, timeoutMs = 8000) {
  const p = cfg.providers[name], key = keyOf(cfg, name);
  if (!key) return { name, ok: false, error: `${p && p.keyEnv} is not set` };
  const t = Date.now();
  try {
    const r = await fetch(p.url + '/models', { headers: { Authorization: 'Bearer ' + key }, signal: AbortSignal.timeout(timeoutMs) });
    const ms = Date.now() - t;
    if (r.ok) return { name, ok: true, status: r.status, ms };
    return { name, ok: false, status: r.status, ms, error: (await r.text()).slice(0, 4000) };
  } catch (e) {
    return { name, ok: false, ms: Date.now() - t, error: e.name === 'TimeoutError' ? 'timed out' : e.message };
  }
}

module.exports = { VERSION, P, DEFAULT_CONFIG, resolveTarget, isTermux, platformName, installHint, c, sym, dur, bytes, ago, formatLog, ensureDirs, appendJsonl, readJsonl, tailFile, rotate, loadConfig, validateConfig, keyOf, probeProvider };
