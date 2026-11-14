#!/usr/bin/env node
'use strict';
const fs = require('fs'), path = require('path'), readline = require('readline'), crypto = require('crypto');
const { spawn, spawnSync, exec } = require('child_process');
const G = require('./common');
const T = require('./textutil');
const K = require('./keys');
const { P, c, sym } = G;
const PKG_NAME = require('../package.json').name;

const out = (...a) => console.log(...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const rand = n => crypto.randomBytes(n).toString('hex');
const num = n => Number(n || 0).toLocaleString('en-US');

K.loadKeys();
let CFG, CFG_ERR = null;
try { CFG = G.loadConfig(); } catch (e) { CFG_ERR = e; CFG = { ...G.DEFAULT_CONFIG }; }
const base = () => `http://127.0.0.1:${CFG.port}`;

// chat state (module level so helpers can use it)
let S = null, ROOT = process.cwd(), lane = CFG.defaultLane, model = null, debug = false;
let ask, flush = () => {};
function askOnce(q) {
  return new Promise(res => { const r = readline.createInterface({ input: process.stdin, output: process.stdout }); r.question(q, a => { r.close(); res(a); }); });
}
ask = askOnce;

function parseArgs(args) {
  const flags = {}, pos = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-n') flags.n = args[++i];
    else if (a === '-f') flags.follow = true;
    else if (a === '-h') flags.help = true;
    else if (a === '-v') flags.version = true;
    else if (a === '--model' || a === '--lane') flags[a.slice(2)] = args[++i];
    else if (a.startsWith('--')) { const [k, v] = a.slice(2).split('='); flags[k] = v === undefined ? true : v; }
    else pos.push(a);
  }
  return { flags, pos };
}

function lg(level, event, data = {}) {
  const rec = { ts: new Date().toISOString(), level, event, session: S && S.id, ...data };
  G.appendJsonl(P.agentLog, rec);
  if (debug) out(c.dim('  ' + G.formatLog(rec)));
}

// ================= router control =================
async function rget(p, { method = 'GET', timeout = 2500 } = {}) {
  try {
    const r = await fetch(base() + p, {
      method, signal: AbortSignal.timeout(timeout),
      headers: method === 'POST' ? { 'Content-Type': 'application/json' } : undefined,
      body: method === 'POST' ? '{}' : undefined,
    });
    let json = null; try { json = await r.json(); } catch {}
    return { ok: r.ok, status: r.status, json };
  } catch { return null; }
}
async function startRouter() {
  const cur = await rget('/health');
  if (cur && cur.json && cur.json.status) return { already: true, health: cur.json };
  G.ensureDirs();
  const fd = fs.openSync(P.routerOut, 'a');
  const child = spawn(process.execPath, [path.join(__dirname, 'router.js')], { detached: true, windowsHide: true, stdio: ['ignore', fd, fd], env: process.env });
  let spawnErr = null;
  child.on('error', e => { spawnErr = e; });
  child.unref();
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    const r = await rget('/health');
    if (r && r.json && r.json.status) return { started: true, health: r.json };
    if (spawnErr || child.exitCode !== null) break;
  }
  throw new Error('router did not start.\n' + G.tailFile(P.routerOut, 15).join('\n') + '\n(more: agt logs router)');
}
async function stopRouter() {
  const r = await rget('/admin/shutdown', { method: 'POST' });
  if (r && r.ok) { for (let i = 0; i < 20; i++) { await sleep(150); if (!(await rget('/health', { timeout: 500 }))) break; } return 'stopped'; }
  if (r) return 'could not stop it (an old router? end the node process that runs it, or restart your terminal)';
  try { process.kill(Number(fs.readFileSync(P.pid, 'utf8')), 'SIGTERM'); await sleep(500); return 'stopped (via pid file)'; } catch { return 'not running'; }
}

// ================= display helpers =================
const dot = s => ({ ok: c.green('● ok'), degraded: c.yellow('● degraded'), down: c.red('● down') }[s] || c.dim('● ' + s));
function printHealth(h) {
  out(`${c.bold('Router')}  ${dot(h.status)}`);
  out(c.dim(`  pid ${h.pid} · port ${h.port} · up ${G.dur(h.uptime_s)} · v${h.version}`));
  out(c.bold('Providers'));
  for (const p of h.providers) out(`  ${p.configured ? sym.ok : sym.fail} ${p.name} ${c.dim(p.keyEnv + (p.configured ? '' : ' (not set)'))}`);
  out(c.bold('Lanes'));
  for (const [n, l] of Object.entries(h.lanes)) out(`  ${n}: ${l.ready}/${l.steps} ready ${l.next ? '→ ' + c.cyan(l.next) : c.red('→ nothing available')}`);
  const cool = Object.entries(h.cooling);
  if (cool.length) { out(c.bold('Parked (cooling down)')); for (const [k, s] of cool) out(`  ${sym.warn} ${k} ${c.dim(s + 's left')}`); }
  if (h.probes) {
    out(c.bold('Live probe'));
    for (const p of h.probes) out(p.ok ? `  ${sym.ok} ${p.name} ${c.dim(p.ms + 'ms')}` : `  ${sym.fail} ${p.name} ${p.status ? 'HTTP ' + p.status : ''}\n${p.error}`);
  }
  if (h.issues && h.issues.length) { out(c.bold('Config notes')); for (const i of h.issues) out(`  ${sym.warn} ${i}`); }
}
function printLogLines(file, n) {
  const lines = G.tailFile(file, n);
  if (!lines.length) return out(c.dim('(empty)'));
  for (const l of lines) { try { out(G.formatLog(JSON.parse(l))); } catch { out(l); } }
}
function followLog(file) {
  fs.appendFileSync(file, '');
  let pos = fs.statSync(file).size, buf = '';
  const show = l => { try { out(G.formatLog(JSON.parse(l))); } catch { out(l); } };
  fs.watchFile(file, { interval: 400 }, st => {
    if (st.size < pos) pos = 0; // the log was rotated
    if (st.size === pos) return;
    const fd = fs.openSync(file, 'r');
    const chunk = Buffer.alloc(st.size - pos);
    fs.readSync(fd, chunk, 0, chunk.length, pos);
    fs.closeSync(fd);
    pos = st.size;
    buf += chunk.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { show(buf.slice(0, i)); buf = buf.slice(i + 1); }
  });
  process.on('SIGINT', () => { fs.unwatchFile(file); process.exit(0); });
}

// ================= sessions & change log =================
const nextId = () => G.readJsonl(P.changes).reduce((m, x) => Math.max(m, x.id || 0), 0) + 1;
function logChange(rec) { G.appendJsonl(P.changes, { ts: new Date().toISOString(), session: S && S.id, cwd: ROOT, ...rec }); }
function listSessions() {
  try {
    return fs.readdirSync(P.sessions).filter(f => f.endsWith('.json'))
      .map(f => { try { return JSON.parse(fs.readFileSync(path.join(P.sessions, f), 'utf8')); } catch { return null; } })
      .filter(Boolean).sort((a, b) => (b.updated || '').localeCompare(a.updated || ''));
  } catch { return []; }
}
function findSession(part, cwd) {
  const all = listSessions();
  return part ? all.find(s => s.id.startsWith(part) || s.id.includes(part)) : all.find(s => !cwd || s.cwd === cwd);
}
const newSession = () => ({ id: new Date().toISOString().replace(/\D/g, '').slice(0, 14) + '-' + rand(2), cwd: ROOT, lane, model, created: new Date().toISOString(), updated: new Date().toISOString(), title: '', messages: [], usage: { prompt: 0, completion: 0 } });
function saveSession() {
  if (!S || !S.messages.length) return;
  S.updated = new Date().toISOString(); S.lane = lane; S.model = model;
  const f = path.join(P.sessions, S.id + '.json');
  fs.writeFileSync(f + '.tmp', JSON.stringify(S)); fs.renameSync(f + '.tmp', f);
}

// ================= file review =================
const rel = full => path.relative(ROOT, full) || '.';
function safe(p) {
  const full = path.resolve(ROOT, p || '.');
  if (!T.isInside(ROOT, full)) throw new Error('path is outside the project folder');
  let real = null;
  try { real = fs.realpathSync(full); } catch {}
  if (real) {
    let rootReal = ROOT;
    try { rootReal = fs.realpathSync(ROOT); } catch {}
    if (!T.isInside(rootReal, real)) throw new Error('path resolves outside the project folder (symlink)');
  }
  const base = path.basename(full);
  if (/^\.env/i.test(base) && !/\.example$/i.test(base)) throw new Error('env files are blocked');
  return full;
}
const noGit = full => { if (path.relative(ROOT, full).split(path.sep).some(s => s.toLowerCase() === '.git')) throw new Error('.git is off limits'); };
const colorDiff = l => (l.startsWith('+') && !l.startsWith('+++') ? c.green(l) : l.startsWith('-') && !l.startsWith('---') ? c.red(l) : l.startsWith('@@') ? c.cyan(l) : c.dim(l));

function makeDiff(r, before, after) {
  return T.unifiedDiff(before, after, before === null ? '/dev/null' : 'a/' + r, 'b/' + r);
}

async function review(action, r, before, after) {
  const lines = makeDiff(r, before, after).replace(/\n$/, '').split('\n');
  const body = lines[0] && lines[0].startsWith('--- ') ? lines.slice(2) : lines;
  const added = body.filter(l => l.startsWith('+')).length;
  const removed = body.filter(l => l.startsWith('-')).length;
  out(`\n${c.yellow('▸ ' + action.toUpperCase())} ${c.bold(r)} ${c.dim(before === null ? '(new file)' : '')}`);
  out(`  ${c.green('+' + added)} ${c.red('-' + removed)} ${c.dim('lines')}`);
  const lim = CFG.previewLines || 20;
  lines.slice(0, lim).forEach(l => out('  ' + colorDiff(l)));
  if (lines.length > lim) out(c.dim(`  … ${lines.length - lim} more diff lines (press d)`));
  for (;;) {
    flush();
    const a = (await ask(`${c.bold('apply?')} ${c.dim('[y]es [n]o [d]iff [v]iew file [s]tage')} › `)).trim().toLowerCase();
    if (a === 'y' || a === 'yes') return { ok: true, added, removed };
    if (a === 'd') lines.forEach(l => out(colorDiff(l)));
    else if (a === 'v') out(c.dim('────── proposed file ──────') + '\n' + after + '\n' + c.dim('───────────────────────────'));
    else if (a === 's') {
      const f = path.join(P.proposed, `${Date.now()}-${path.basename(r)}`);
      fs.writeFileSync(f, after);
      out(c.dim(`  staged copy: ${f}\n  (your real file is untouched; open the copy in your editor, then answer here)`));
    } else if (a === 'n' || a === 'no' || a === '') {
      flush();
      return { ok: false, reason: (await ask(c.dim('  reason for the agent (optional) › '))).trim() };
    } else out(c.dim('  type y, n, d, v or s'));
  }
}

async function applyChange(action, full, before, after) {
  const r = rel(full);
  if (before === after) { out(`${c.cyan('▸')} ${action} ${r} ${c.dim('no change')}`); return 'No change: the file already has this content.'; }
  const d = await review(action, r, before, after);
  const id = nextId();
  if (!d.ok) {
    logChange({ id, action, status: 'denied', path: r, abs: full, reason: d.reason });
    out(`  ${sym.fail} denied`);
    return 'The user denied this change.' + (d.reason ? ' Reason: ' + d.reason : '');
  }
  let backup = null;
  if (before !== null) {
    backup = path.join(P.backups, S.id, `${id}-${path.basename(full)}`);
    fs.mkdirSync(path.dirname(backup), { recursive: true });
    fs.writeFileSync(backup, before);
  }
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, after);
  logChange({ id, action, status: 'applied', path: r, abs: full, existed: before !== null, backup, sha_after: crypto.createHash('sha1').update(after).digest('hex'), added: d.added, removed: d.removed });
  out(`  ${sym.ok} applied ${c.dim('(change #' + id + ' · undo with /undo)')}`);
  return `${action === 'edit' ? 'Edited' : 'Wrote'} ${r} (+${d.added} -${d.removed} lines).`;
}

async function undoChange(askFn, id, force) {
  const all = G.readJsonl(P.changes);
  const undone = new Set(all.filter(x => x.action === 'undo' && x.status === 'applied').map(x => x.of));
  const cand = all.filter(x => (x.action === 'write' || x.action === 'edit') && x.status === 'applied' && !undone.has(x.id));
  const t = id ? cand.find(x => x.id === id) : cand.filter(x => x.cwd === process.cwd()).pop();
  if (!t) { out('nothing to undo' + (id ? ` (no undoable change #${id})` : ' in this folder')); return 1; }
  const cur = fs.existsSync(t.abs) ? fs.readFileSync(t.abs, 'utf8') : null;
  const sha = cur === null ? null : crypto.createHash('sha1').update(cur).digest('hex');
  out(`${c.yellow('▸ UNDO')} #${t.id} ${t.action} ${c.bold(t.path)} ${c.dim(G.ago(t.ts))}`);
  out(c.dim(t.backup ? '  restores the version from before this change' : '  deletes the file this change created'));
  if (sha !== t.sha_after && !force) { out(`${sym.warn} the file changed since then. Undo later changes first, or run: agt undo ${t.id} --force`); return 1; }
  const a = (await askFn('proceed? [y/N] › ')).trim().toLowerCase();
  if (a !== 'y' && a !== 'yes') { out('left as is'); return 0; }
  if (t.backup) fs.copyFileSync(t.backup, t.abs); else fs.rmSync(t.abs, { force: true });
  G.appendJsonl(P.changes, { id: nextId(), ts: new Date().toISOString(), action: 'undo', of: t.id, status: 'applied', cwd: process.cwd(), path: t.path });
  out(`${sym.ok} restored`);
  return 0;
}

// ================= tools =================
const clipForModel = s => {
  const max = CFG.maxToolChars;
  if (s.length <= max) return s;
  out(c.dim(`  (clipped for the model only: sent ${num(max)} of ${num(s.length)} chars)`));
  return s.slice(0, max) + `\n[clipped: showing ${max} of ${s.length} chars. Use start_line/end_line to read more.]`;
};

const tools = {
  async list_dir({ path: p }) {
    const full = safe(p);
    const items = fs.readdirSync(full, { withFileTypes: true }).filter(d => !['node_modules', '.git'].includes(d.name)).map(d => d.name + (d.isDirectory() ? '/' : ''));
    out(`${c.cyan('▸')} list_dir ${c.bold(rel(full))} ${c.dim(items.length + ' entries')}`);
    return items.join('\n') || '(empty)';
  },
  async read_file({ path: p, start_line, end_line }) {
    const full = safe(p);
    if (fs.statSync(full).isDirectory()) throw new Error(rel(full) + ' is a directory, not a file. Use list_dir to see what is inside.');
    let t = fs.readFileSync(full, 'utf8');
    if (t.includes('\u0000')) throw new Error('binary file, not readable as text');
    const total = t.split('\n').length;
    if (start_line || end_line) t = t.split('\n').slice((start_line || 1) - 1, end_line || undefined).join('\n');
    out(`${c.cyan('▸')} read_file ${c.bold(rel(full))} ${c.dim(total + ' lines, ' + G.bytes(Buffer.byteLength(t)) + (start_line || end_line ? `, range ${start_line || 1}-${end_line || total}` : ''))}`);
    return t;
  },
  async write_file({ path: p, content }) {
    const full = safe(p); noGit(full);
    if (typeof content !== 'string') throw new Error('content must be a string');
    const before = fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : null;
    return applyChange('write', full, before, before === null ? content : T.matchEol(content, before));
  },
  async edit_file({ path: p, old_str, new_str }) {
    const full = safe(p); noGit(full);
    if (!old_str || typeof new_str !== 'string') throw new Error('old_str and new_str are required');
    if (fs.statSync(full).isDirectory()) throw new Error(rel(full) + ' is a directory, not a file.');
    const before = fs.readFileSync(full, 'utf8');
    const e = T.applyEdit(before, old_str, new_str);
    if (!e.ok) throw new Error(`old_str must match exactly once but matched ${e.count} times. Read the file again and use a more specific snippet.`);
    return applyChange('edit', full, before, e.after);
  },
  async run_command({ command }) {
    if (typeof command !== 'string' || !command.trim()) throw new Error('command is empty');
    const warns = [];
    if (/\.env(?!\.example)/.test(command)) warns.push('mentions an env file');
    if (/\brm\s+-\w*[rf]/.test(command)) warns.push('deletes files');
    if (/\bsudo\b/.test(command)) warns.push('uses sudo');
    if (/\bgit\s+(push|reset\s+--hard|clean|checkout\s+\.|restore)/.test(command)) warns.push('changes git history or discards work');
    if (/(curl|wget)[^|]*\|\s*(sh|bash)/.test(command)) warns.push('pipes a download into a shell');
    out(`\n${c.yellow('▸ RUN')} ${c.bold(command)}`);
    warns.forEach(w => out(`  ${sym.warn} ${c.yellow('caution: ' + w)}`));
    flush();
    const a = (await ask(`${c.bold('run it?')} ${c.dim('[y]es [n]o')} › `)).trim().toLowerCase();
    const id = nextId();
    if (a !== 'y' && a !== 'yes') {
      flush();
      const why = (await ask(c.dim('  reason for the agent (optional) › '))).trim();
      logChange({ id, action: 'run', status: 'denied', command, reason: why });
      out(`  ${sym.fail} denied`);
      return 'The user denied this command.' + (why ? ' Reason: ' + why : '');
    }
    const t0 = Date.now();
    const r = await new Promise(resolve => exec(command, { cwd: ROOT, timeout: CFG.commandTimeoutSec * 1000, maxBuffer: 20e6 }, (err, stdout, stderr) => resolve({ err, stdout, stderr })));
    const timedOut = !!(r.err && r.err.killed);
    const code = r.err ? (timedOut ? 'timeout' : r.err.code) : 0;
    out(`${code === 0 ? sym.ok : sym.fail} exit ${code} ${c.dim('· ' + ((Date.now() - t0) / 1000).toFixed(1) + 's')}`);
    if (r.stdout) out(r.stdout.replace(/\n$/, ''));
    if (r.stderr) out(c.red(r.stderr.replace(/\n$/, '')));
    logChange({ id, action: 'run', status: code === 0 ? 'applied' : 'failed', command, exit: code, ms: Date.now() - t0 });
    return `exit code: ${code}${timedOut ? ` (timed out after ${CFG.commandTimeoutSec}s)` : ''}\n[stdout]\n${r.stdout}\n[stderr]\n${r.stderr}`;
  },
};

const tool = (name, description, properties, required) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, ...(required.length ? { required } : {}) } } });
const STR = { type: 'string' }, INT = { type: 'integer' };
const TOOLS = [
  tool('list_dir', 'List files in a project directory', { path: STR }, []),
  tool('read_file', 'Read a text file; optional line range', { path: STR, start_line: INT, end_line: INT }, ['path']),
  tool('write_file', 'Create or overwrite a file with full content', { path: STR, content: STR }, ['path', 'content']),
  tool('edit_file', 'Replace one exact, unique snippet in a file', { path: STR, old_str: STR, new_str: STR }, ['path', 'old_str', 'new_str']),
  tool('run_command', 'Run a shell command in the project root', { command: STR }, ['command']),
];

// ================= model calls =================
let SYSTEM = '', ctl = null, thinking = false;
function buildSystem() {
  let ctx = '';
  for (const f of ['GEMINI.md', 'AGENTS.md']) {
    const fp = path.join(ROOT, f);
    if (fs.existsSync(fp)) ctx += `\n\nProject notes (${f}):\n` + fs.readFileSync(fp, 'utf8').slice(0, CFG.maxToolChars);
  }
  return `You are a careful coding agent working in ${ROOT}, on ${G.platformName()}. Shell commands run with ${process.platform === 'win32' ? 'cmd.exe' : 'sh'}. Inspect files with your tools before changing anything. Prefer edit_file with a small unique snippet over rewriting whole files. The user reviews every file change and command before it runs; if one is denied, read the reason and adjust. Tool output may be clipped: read large files in line ranges. Never read or print secrets or env files. Keep replies short and say what you changed.` + ctx;
}
function prettyErr(text) {
  try {
    const j = JSON.parse(text), e = j.error || j;
    let s = typeof e === 'string' ? e : e.message || text;
    for (const a of e.attempts || []) s += `\n  ${sym.fail} ${a.via} ${a.status ? 'HTTP ' + a.status : 'no response'} (${a.ms}ms)\n${a.error}`;
    return s;
  } catch { return text; }
}
async function callModel(signal) {
  const t0 = Date.now();
  const r = await fetch(base() + '/v1/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
    body: JSON.stringify({ model: model || lane, messages: [{ role: 'system', content: SYSTEM }, ...S.messages], tools: TOOLS }),
  });
  const text = await r.text();
  const via = r.headers.get('x-router-via'), rid = r.headers.get('x-router-id');
  if (!r.ok) { const e = new Error(`router returned HTTP ${r.status}` + (rid ? ` (request ${rid})` : '')); e.detail = prettyErr(text); throw e; }
  let data; try { data = JSON.parse(text); } catch { throw new Error('router sent invalid JSON:\n' + text); }
  const ch = data.choices && data.choices[0];
  if (!ch) throw new Error('response had no choices:\n' + text);
  const { reasoning, reasoning_content, annotations, refusal, ...msg } = ch.message;
  return { msg, usage: data.usage || {}, via, rid, ms: Date.now() - t0, finish: ch.finish_reason };
}
async function execTool(tc) {
  const name = tc.function.name;
  let args;
  try { args = JSON.parse(tc.function.arguments || '{}'); }
  catch (e) { const m = `Error: invalid JSON arguments: ${e.message}`; out(`${sym.fail} ${name}: ${m}`); return m; }
  lg('debug', 'tool_call', { name, args: name === 'write_file' ? { path: args.path, chars: (args.content || '').length } : args });
  let result;
  try {
    if (!tools[name]) throw new Error('unknown tool ' + name);
    result = String(await tools[name](args));
  } catch (e) { result = 'Error: ' + e.message; out(`  ${sym.fail} ${c.red(e.message)}`); lg('error', 'tool_error', { name, error: e.message }); }
  return clipForModel(result);
}
const think = on => {
  if (!process.stdout.isTTY) return;
  if (on) { process.stdout.write(c.dim('  … waiting for model')); thinking = true; }
  else if (thinking) { process.stdout.write('\r\x1b[K'); thinking = false; }
};
async function runTurn(text) {
  const mark = S.messages.length;
  S.messages.push({ role: 'user', content: text });
  if (!S.title) S.title = text.replace(/\s+/g, ' ').slice(0, 70);
  let step = 0;
  try {
    for (step = 1; step <= CFG.maxSteps; step++) {
      ctl = new AbortController();
      think(true);
      let r;
      try { r = await callModel(ctl.signal); } finally { ctl = null; think(false); }
      const { msg, usage } = r;
      for (const tc of msg.tool_calls || []) tc.id = tc.id || 'call_' + rand(4);
      S.messages.push(msg);
      S.usage.prompt += usage.prompt_tokens || 0; S.usage.completion += usage.completion_tokens || 0;
      lg('debug', 'model_reply', { via: r.via, ms: r.ms, finish: r.finish, tool_calls: (msg.tool_calls || []).length });
      out(c.dim(`  ↳ ${r.via || lane} · ${(r.ms / 1000).toFixed(1)}s${usage.total_tokens ? ' · ' + num(usage.total_tokens) + ' tokens' : ''}`));
      if (msg.content) out('\n' + msg.content);
      if (!msg.tool_calls || !msg.tool_calls.length) {
        if (!msg.content) out(c.yellow(`(the model returned an empty reply, finish_reason=${r.finish})`));
        break;
      }
      for (const tc of msg.tool_calls) S.messages.push({ role: 'tool', tool_call_id: tc.id, content: await execTool(tc) });
      saveSession();
    }
    if (step > CFG.maxSteps) out(c.yellow(`\n(stopped after ${CFG.maxSteps} steps; say "continue" to go on)`));
  } catch (e) {
    think(false);
    if (e.name === 'AbortError') out(c.yellow('\n■ cancelled'));
    else {
      out(`\n${sym.fail} ${c.red(e.message)}`);
      if (e.detail) out(e.detail);
      out(c.dim('  /log shows router details · agt doctor diagnoses'));
      lg('error', 'turn_failed', { error: e.message, detail: e.detail });
    }
    if (S.messages.length === mark + 1) S.messages.length = mark;
  }
  flush(); saveSession();
}

// ================= chat =================
const CHAT_HELP = `${c.bold('Chat commands')}
  /plan  /edit      switch lane (see: agt config)
  /lane <name>      switch to any lane in your config
  /new              start a new session (the old one stays saved)
  /compact          summarize this chat to save tokens (full copy is kept)
  /model [name]     pin one exact model (alias or provider/model); /model auto unpins
  /models [live]    list lanes, aliases and models
  /status           session, context size, router health
  /health [deep]    router health (deep = live provider test)
  /stats            request counts per provider
  /log [n]          recent router log lines
  /changes          files and commands the agent touched
  /undo [id]        restore a file the agent changed
  /sessions         list saved sessions
  /debug            toggle verbose debug lines
  /exit             save and quit
${c.dim('Pasted multi-line text is sent as one message. Ctrl+C cancels a running request.')}`;

async function slash(line) {
  const [cmd, ...rest] = line.slice(1).split(/\s+/);
  switch (cmd) {
    case 'help': out(CHAT_HELP); break;
    case 'plan': case 'edit': case 'lane': {
      const want = cmd === 'lane' ? rest[0] : cmd;
      if (want && CFG.lanes[want]) { lane = want; out(`lane: ${c.cyan(lane)}${model ? c.dim('  (model ' + model + ' is still pinned; /model auto to use the lane)') : ''}`); }
      else out(`lanes: ${Object.keys(CFG.lanes).join(', ')}`);
      break;
    }
    case 'model': {
      if (!rest[0]) {
        out(model ? `pinned model: ${c.cyan(model)}  ${c.dim('(/model auto goes back to lane ' + lane + ')')}` : `no model pinned; routing by lane ${c.cyan(lane)}`);
        out(c.dim('pin one: /model <alias|provider/model>    list them: /models'));
        break;
      }
      if (['auto', 'off', 'lane', 'none'].includes(rest[0])) { model = null; out(`model unpinned; routing by lane ${c.cyan(lane)}`); break; }
      const tg = G.resolveTarget(CFG, rest[0]);
      if (!tg) { out(`${sym.fail} "${rest[0]}" is not an alias, a lane or a provider/model. Try /models`); break; }
      if (tg.type === 'lane') { lane = rest[0]; model = null; out(`"${rest[0]}" is a lane: lane set, model unpinned`); break; }
      if (!G.keyOf(CFG, tg.steps[0][0])) out(`${sym.warn} ${tg.steps[0][0]} has no API key yet: agt keys set ${tg.steps[0][0]}`);
      model = rest[0];
      out(`model pinned: ${c.cyan(tg.label)} ${c.dim('(no failover while pinned; /model auto undoes it)')}`);
      break;
    }
    case 'models': await printModels(rest.find(x => x !== 'live'), rest.includes('live')); break;
    case 'new': saveSession(); S = newSession(); out(`new session ${S.id}`); break;
    case 'compact': await compact(); break;
    case 'status': {
      const est = Math.round(JSON.stringify(S.messages).length / 4);
      out(`${c.bold('Session')} ${S.id}\n  ${model ? 'model ' + model + ' (pinned)' : 'lane ' + lane} · ${S.messages.length} messages · ~${num(est)} tokens in context`);
      out(c.dim(`  used so far: ${num(S.usage.prompt)} prompt + ${num(S.usage.completion)} completion tokens`));
      if (est > 60000) out(`  ${sym.warn} context is getting large; /new starts fresh (this session stays saved)`);
      const r = await rget('/health');
      if (r && r.json) printHealth(r.json); else out(`${c.red('router not reachable')} (agt router start)`);
      break;
    }
    case 'health': await cmdHealth([], { deep: rest.includes('deep') }); break;
    case 'stats': await cmdStats(); break;
    case 'log': printLogLines(P.routerLog, Number(rest[0]) || 20); break;
    case 'changes': cmdChanges([], {}); break;
    case 'undo': await undoChange(ask, rest[0] ? Number(rest[0]) : null, false); break;
    case 'sessions': cmdSessions([]); break;
    case 'debug': debug = !debug; out(`debug ${debug ? 'on' : 'off'}`); break;
    case 'exit': case 'quit': return 'exit';
    default: out(`unknown command /${cmd}. Try /help`);
  }
}

async function cmdChat(pos, flags, resume) {
  if (!process.stdin.isTTY) { out(c.red('chat needs an interactive terminal')); return 1; }
  G.ensureDirs(); G.rotate(P.agentLog);
  ROOT = process.cwd(); debug = !!flags.debug;
  if (flags.plan) lane = 'plan'; else if (flags.edit) lane = 'edit';
  if (!CFG.lanes[lane]) lane = CFG.defaultLane;
  model = null;
  if (flags.lane) { if (CFG.lanes[flags.lane]) lane = flags.lane; else { out(`${sym.fail} unknown lane "${flags.lane}". Lanes: ${Object.keys(CFG.lanes).join(', ')}`); return 1; } }
  if (flags.model) {
    const tg = G.resolveTarget(CFG, flags.model);
    if (!tg) { out(`${sym.fail} unknown model "${flags.model}". See: agt models`); return 1; }
    if (tg.type === 'lane') lane = flags.model; else model = flags.model;
  }

  let rs;
  try { rs = await startRouter(); } catch (e) { out(`${sym.fail} ${e.message}`); return 1; }
  const startedRouter = !!rs.started, h = rs.health;
  out(`${c.bold('router')} ${dot(h.status)} ${c.dim('· providers: ' + (h.providers.filter(p => p.configured).map(p => p.name).join(', ') || 'NONE'))}${startedRouter ? c.dim(' · just started') : ''}`);
  if (h.status === 'down') out(`${sym.warn} no provider can serve requests. Run: agt doctor`);

  if (resume) {
    S = findSession(resume === true ? null : resume, ROOT);
    if (!S) { out(`${sym.fail} no saved session found${resume === true ? ' for this folder' : ''}. List them: agt sessions`); return 1; }
    if (S.cwd !== ROOT) {
      if (!fs.existsSync(S.cwd)) { out(`${sym.fail} that session's folder no longer exists: ${S.cwd}`); return 1; }
      process.chdir(S.cwd); ROOT = S.cwd;
    }
    if (S.lane && CFG.lanes[S.lane]) lane = S.lane;
    if (S.model && !flags.model && G.resolveTarget(CFG, S.model)) model = S.model;
    S.usage = S.usage || { prompt: 0, completion: 0 };
  } else S = newSession();
  SYSTEM = buildSystem();
  out(`\n${c.bold('agt')} ${c.dim('v' + G.VERSION)} · ${ROOT}\n${c.dim('session ' + S.id + ' · lane ' + lane + (model ? ' · pinned ' + model : '') + (resume ? ` · resumed (${S.messages.length} messages)` : ''))}\n${c.dim('/help for commands · Ctrl+C cancels a request')}`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const queue = []; let waiter = null, waiting = false, quitting = false;
  rl.on('line', l => { if (waiter) { const w = waiter; waiter = null; w(l); } else queue.push(l); });
  ask = q => new Promise(res => {
    rl.setPrompt(q);
    if (queue.length) return res(queue.shift());
    waiting = true; waiter = l => { waiting = false; res(l); }; rl.prompt();
  });
  flush = () => { queue.length = 0; };

  const quit = async (code = 0) => {
    if (quitting) return; quitting = true;
    saveSession();
    if (startedRouter && !flags.keep) out(c.dim('router ' + await stopRouter()));
    else if (startedRouter) out(c.dim('router left running (stop it with: agt router stop)'));
    out(c.dim(S.messages.length ? `session saved: ${S.id}  ·  continue with: agt resume` : 'bye'));
    process.exit(code);
  };
  rl.on('SIGINT', () => { if (ctl) ctl.abort(); else if (waiting) { out(''); quit(0); } });
  rl.on('close', () => quit(0));
  for (const s of ['SIGTERM', 'SIGHUP']) process.on(s, () => quit(0));

  const first = pos.join(' ').trim();
  if (first) await runTurn(first);
  for (;;) {
    let line = await ask(`\n${c.cyan('[' + (model ? 'model: ' + model : lane) + ']')} › `);
    await sleep(50);
    while (queue.length) line += '\n' + queue.shift();
    line = line.trim();
    if (!line) continue;
    if (line.startsWith('/')) { if ((await slash(line)) === 'exit') break; continue; }
    await runTurn(line);
  }
  await quit(0);
  return 0;
}

// ================= keys & setup =================
const KEY_URLS = { gemini: 'https://aistudio.google.com/apikey', groq: 'https://console.groq.com/keys', cerebras: 'https://cloud.cerebras.ai', openrouter: 'https://openrouter.ai/keys' };

// Reads a secret without echoing it. With piped input (or forceLine) it just reads one line.
function readSecret(prompt, forceLine = false) {
  return new Promise(resolve => {
    const stdin = process.stdin;
    if (!stdin.isTTY || forceLine) {
      const r = readline.createInterface({ input: stdin });
      let got = false;
      r.once('line', l => { got = true; r.close(); resolve(l); });
      r.once('close', () => { if (!got) resolve(''); });
      return;
    }
    let buf = '';
    stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8'); // no echo from here on
    process.stdout.write(prompt);
    const done = v => {
      stdin.setRawMode(false); stdin.pause(); stdin.removeListener('data', onData);
      process.stdout.write(v ? c.dim(` (${v.length} characters received)\n`) : '\n');
      resolve(v);
    };
    const onData = chunk => {
      if (chunk.startsWith('\x1b')) return; // arrow keys etc.
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return done(buf);
        if (ch === '\u0003') { stdin.setRawMode(false); process.stdout.write('\n'); process.exit(130); }
        if (ch === '\u007f' || ch === '\b') buf = buf.slice(0, -1);
        else if (ch >= ' ') buf += ch;
      }
    };
    stdin.on('data', onData);
  });
}

// accepts a provider name (groq) or the variable name (GROQ_API_KEY)
function keyTarget(arg) {
  if (!arg) return null;
  if (CFG.providers[arg]) return { name: CFG.providers[arg].keyEnv, provider: arg };
  const hit = Object.entries(CFG.providers).find(([, p]) => p.keyEnv === arg);
  if (hit) return { name: arg, provider: hit[0] };
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(arg) ? { name: arg, provider: null } : null;
}

async function cmdKeys(pos, flags) {
  const sub = pos[0] || 'list';
  if (sub === 'path') { out(P.keys); return 0; }
  if (sub === 'list') {
    out(c.bold('API keys') + c.dim('  (values are never shown)'));
    for (const [name, p] of Object.entries(CFG.providers)) {
      const v = G.keyOf(CFG, name);
      out(`  ${v ? sym.ok : sym.fail} ${name.padEnd(11)} ${c.dim(p.keyEnv + (v ? ` · ${v.length} chars · from ${K.SOURCE[p.keyEnv] || 'environment'}` : ' · not set'))}`);
    }
    out(c.dim(`\nkeys file: ${P.keys}\nadd a key: agt keys set <provider>`));
    return 0;
  }
  if (sub === 'set') {
    const t = keyTarget(pos[1]);
    if (!t) { out(`usage: agt keys set <provider|VARIABLE_NAME> [--stdin]\nproviders: ${Object.keys(CFG.providers).join(', ')}`); return 1; }
    const value = (await readSecret(`${t.name} (input is hidden): `, !!flags.stdin)).trim();
    if (!value) { out(`${sym.fail} nothing entered, nothing saved`); return 1; }
    try { K.saveKey(t.name, value); } catch (e) { out(`${sym.fail} ${e.message}`); return 1; }
    process.env[t.name] = value;
    out(`${sym.ok} saved ${t.name} to ${P.keys}`);
    if (t.provider && !flags['no-test']) {
      const r = await G.probeProvider(CFG, t.provider);
      out(r.ok ? `${sym.ok} ${t.provider} accepted the key (${r.ms}ms)` : `${sym.warn} ${t.provider} said: ${r.status ? 'HTTP ' + r.status + ' ' : ''}${r.error}`);
    }
    return 0;
  }
  if (sub === 'remove') {
    const t = keyTarget(pos[1]);
    if (!t) { out('usage: agt keys remove <provider|VARIABLE_NAME>'); return 1; }
    out(K.removeKey(t.name) ? `${sym.ok} removed ${t.name} from the keys file` : `${sym.info} ${t.name} was not in the keys file`);
    if (process.env[t.name]) out(c.dim('  (it is still set in your environment; remove it there too)'));
    return 0;
  }
  out('usage: agt keys [list|set <provider>|remove <provider>|path]');
  return 1;
}

async function cmdSetup() {
  if (!process.stdin.isTTY) { out('agt setup needs an interactive terminal. Scripted alternative: agt keys set <provider> --stdin'); return 1; }
  out(`${c.bold('agt setup')}  ${c.dim('paste a key and press Enter, or just Enter to skip')}`);
  let added = 0;
  for (const [name, p] of Object.entries(CFG.providers)) {
    if (G.keyOf(CFG, name)) { out(`\n${sym.ok} ${name}: already set (${p.keyEnv})`); continue; }
    out(`\n${c.bold(name)} ${KEY_URLS[name] ? c.dim('free key: ' + KEY_URLS[name]) : ''}`);
    const v = (await readSecret(`  ${p.keyEnv}: `)).trim();
    if (!v) { out(c.dim('  skipped')); continue; }
    try { K.saveKey(p.keyEnv, v); } catch (e) { out(`  ${sym.fail} ${e.message}`); continue; }
    process.env[p.keyEnv] = v; added++;
    const r = await G.probeProvider(CFG, name);
    out(r.ok ? `  ${sym.ok} saved, and ${name} accepted it (${r.ms}ms)` : `  ${sym.warn} saved, but ${name} said: ${r.status ? 'HTTP ' + r.status + ' ' : ''}${r.error}`);
  }
  out(`\n${added ? 'Done.' : 'Nothing changed.'} Next: ${c.bold('agt doctor')}, then ${c.bold('agt')} inside a project folder.`);
  return 0;
}

// ================= updates =================
async function latestVersion() {
  const reg = (process.env.AGT_REGISTRY || 'https://registry.npmjs.org').replace(/\/$/, '');
  try {
    const r = await fetch(`${reg}/${PKG_NAME}/latest`, { signal: AbortSignal.timeout(4000), headers: { Accept: 'application/json' } });
    if (!r.ok) return null;
    const j = await r.json();
    return typeof j.version === 'string' ? j.version : null;
  } catch { return null; }
}
const newer = (a, b) => {
  const p = v => String(v).split('-')[0].split('.').map(n => parseInt(n, 10) || 0);
  const x = p(a), y = p(b);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
};
async function cmdUpdate(pos, flags) {
  const viaNpm = path.resolve(__dirname, '..').split(path.sep).includes('node_modules');
  const latest = await latestVersion();
  out(`installed ${G.VERSION} · latest ${latest || 'unknown (offline?)'}`);
  if (!latest) return 1;
  if (!newer(latest, G.VERSION)) { out(`${sym.ok} already up to date`); return 0; }
  if (flags.check) { out(`${sym.warn} update available: ${latest}`); return 0; }
  if (!viaNpm) { out(`This copy was not installed with npm. Update it with:\n  npm install -g ${PKG_NAME}@latest`); return 0; }
  out(c.dim(`running: npm install -g ${PKG_NAME}@latest`));
  const r = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '-g', `${PKG_NAME}@latest`], { stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status === 0) out(`${sym.ok} updated. If a router is running, restart it: agt router restart`);
  return r.status || 0;
}

// ================= models (separate from lanes) =================
async function listModels(name) {
  const p = CFG.providers[name], key = G.keyOf(CFG, name);
  if (!key) return { error: `${p.keyEnv} is not set` };
  try {
    const r = await fetch(p.url + '/models', { headers: { Authorization: 'Bearer ' + key }, signal: AbortSignal.timeout(10000) });
    const text = await r.text();
    if (!r.ok) return { error: `HTTP ${r.status} ${text}` };
    const j = JSON.parse(text);
    return { ids: (j.data || j.models || []).map(m => String(m.id || m.name).replace(/^models\//, '')).sort() };
  } catch (e) { return { error: e.message }; }
}
async function printModels(filter, live) {
  out(c.bold('Lanes') + c.dim('  (ordered failover, used when no model is pinned)'));
  for (const [n, steps] of Object.entries(CFG.lanes)) out(`  ${n}: ${steps.map(s => s.join('/')).join(c.dim(' → '))}`);
  const al = Object.entries(CFG.aliases || {});
  if (al.length) { out(c.bold('Aliases') + c.dim('  (short names for one model)')); for (const [a, s] of al) out(`  ${a} = ${s}`); }
  out(c.bold('Providers'));
  for (const name of Object.keys(CFG.providers)) {
    if (filter && name !== filter) continue;
    out(`  ${G.keyOf(CFG, name) ? sym.ok : sym.fail} ${name}${G.keyOf(CFG, name) ? '' : c.dim('  (no key)')}`);
    if (!live) continue;
    const r = await listModels(name);
    if (r.error) out(`    ${sym.fail} ${r.error}`);
    else r.ids.forEach(id => out(`    ${name}/${id}`));
  }
  if (filter && !CFG.providers[filter]) out(`${sym.warn} no provider named "${filter}"`);
  out(c.dim(`\npin one: /model <alias|provider/model-id>  (or: agt --model fast)${live ? '' : '\nsee every model a provider offers: agt models --live'}`));
}
const cmdModels = (pos, flags) => printModels(pos[0], !!flags.live).then(() => 0);

// ================= compact =================
async function compact() {
  if (S.messages.length < 4) { out('nothing to compact yet'); return; }
  const text = S.messages.map(m => m.role === 'user' ? `USER: ${m.content}`
    : m.role === 'assistant' ? `ASSISTANT: ${m.content || ''}${(m.tool_calls || []).map(tc => `\n[called ${tc.function.name} ${String(tc.function.arguments).slice(0, 300)}]`).join('')}`
    : `TOOL RESULT: ${String(m.content).slice(0, 1500)}`).join('\n\n');
  const prompt = 'Summarize this coding-agent session so the work can continue in a fresh context. Include: the goal, what has been done (files changed), what remains, and key facts (paths, decisions, errors seen). Be concrete and stay under 350 words.\n\n' + text.slice(-24000);
  out(c.dim('  summarizing this session to save tokens…'));
  let summary = '';
  try {
    const r = await fetch(base() + '/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(CFG.requestTimeoutSec * 1000),
      body: JSON.stringify({ model: model || lane, messages: [{ role: 'user', content: prompt }] }),
    });
    const t = await r.text();
    if (!r.ok) throw new Error(`router returned HTTP ${r.status}\n${prettyErr(t)}`);
    summary = (JSON.parse(t).choices[0].message.content || '').trim();
  } catch (e) { out(`${sym.fail} could not summarize: ${e.message}`); return; }
  if (!summary) { out(`${sym.fail} the model returned an empty summary; history left unchanged`); return; }
  const before = JSON.stringify(S.messages).length;
  saveSession();
  fs.writeFileSync(path.join(P.sessions, `${S.id}.${Date.now()}.precompact.bak`), JSON.stringify(S));
  S.messages = [
    { role: 'user', content: 'Summary of our work so far (older messages were compacted to save tokens):\n' + summary },
    { role: 'assistant', content: 'Understood. I have the summary and can continue from here.' },
  ];
  saveSession();
  out(`${sym.ok} compacted: ~${num(Math.round(before / 4))} → ~${num(Math.round(JSON.stringify(S.messages).length / 4))} tokens ${c.dim('(the full history is kept in the sessions folder)')}`);
}

// ================= commands =================
async function cmdHealth(pos, flags) {
  const r = await rget('/health' + (flags.deep ? '?deep=1' : ''), { timeout: flags.deep ? 20000 : 2500 });
  if (!r || !r.json || !r.json.status) { out(`${c.bold('Router')}  ${c.red('● not running')}\n${c.dim('  start it: agt router start')}`); return 1; }
  if (flags.json) out(JSON.stringify(r.json, null, 2)); else printHealth(r.json);
  return r.json.status === 'down' ? 2 : 0;
}
async function cmdStats() {
  const r = await rget('/stats');
  if (!r || !r.json) { out(c.red('router not running') + c.dim(' (agt router start)')); return 1; }
  const s = r.json, days = Object.keys(s.daily).sort().reverse();
  out(c.bold('Requests by day (UTC)'));
  out(c.dim('  provider quotas reset on their own clocks, so treat this as an estimate'));
  if (!days.length) out('  none recorded yet');
  for (const d of days) {
    out(c.cyan(d));
    for (const [k, v] of Object.entries(s.daily[d])) out(`  ${k}\n    ${c.green(v.ok + ' ok')} · ${v.fail ? c.red(v.fail + ' failed') : c.dim('0 failed')}`);
  }
  return 0;
}
async function cmdLogs(pos, flags) {
  const file = (pos[0] || 'router') === 'agent' ? P.agentLog : P.routerLog;
  if (flags.raw) { out(G.tailFile(file, Number(flags.n) || 40).join('\n')); return 0; }
  printLogLines(file, Number(flags.n) || 40);
  if (flags.follow) followLog(file);
  return 0;
}
async function cmdRouter(pos, flags) {
  switch (pos[0] || 'status') {
    case 'start': { const r = await startRouter(); out(r.already ? `${sym.info} already running` : `${sym.ok} started`); printHealth(r.health); return 0; }
    case 'stop': out(`router: ${await stopRouter()}`); return 0;
    case 'restart': { out(`router: ${await stopRouter()}`); await sleep(400); const r = await startRouter(); out(`${sym.ok} started`); printHealth(r.health); return 0; }
    case 'reset': { const r = await rget('/admin/reset', { method: 'POST' }); out(r && r.ok ? `${sym.ok} cooldowns cleared` : `${sym.fail} router not reachable`); return r && r.ok ? 0 : 1; }
    case 'status': return cmdHealth([], flags);
    case 'logs': return cmdLogs(['router'], flags);
    default: out('usage: agt router start|stop|restart|status|reset|logs'); return 1;
  }
}
async function cmdConfig(pos) {
  const sub = pos[0] || 'show';
  if (sub === 'path') { out(P.config); return 0; }
  if (sub === 'edit') {
    const editor = process.env.VISUAL || process.env.EDITOR || (process.platform === 'win32' ? 'notepad' : 'nano');
    spawnSync(`${editor} "${P.config}"`, { stdio: 'inherit', shell: true });
    try {
      const iss = G.validateConfig(G.loadConfig());
      if (iss.length) iss.forEach(i => out(`${sym.warn} ${i}`)); else out(`${sym.ok} config is valid`);
    } catch (e) { out(`${sym.fail} ${e.message}`); return 1; }
    const r = await rget('/admin/reload', { method: 'POST' });
    if (r && r.ok) out(`${sym.ok} router reloaded the config ${c.dim('(a changed port needs: agt router restart)')}`);
    return 0;
  }
  out(c.dim(P.config));
  if (CFG_ERR) { out(`${sym.fail} ${CFG_ERR.message}`); return 1; }
  out(JSON.stringify(CFG, null, 2));
  for (const i of G.validateConfig(CFG)) out(`${sym.warn} ${i}`);
  return 0;
}
function cmdSessions(pos) {
  if (pos[0] === 'rm') {
    const s = pos[1] && findSession(pos[1]);
    if (!s) { out('usage: agt sessions rm <id>'); return 1; }
    fs.rmSync(path.join(P.sessions, s.id + '.json'), { force: true });
    out(`${sym.ok} deleted chat ${s.id} ${c.dim('(file backups stay, so /undo still works)')}`);
    return 0;
  }
  const all = listSessions();
  if (!all.length) { out(c.dim('no saved sessions yet')); return 0; }
  all.slice(0, Number(pos[0]) || 15).forEach(s => {
    out(`${c.bold(s.id)} ${c.dim('· ' + s.lane + ' · ' + s.messages.length + ' msgs · ' + G.ago(s.updated))}`);
    out(c.dim('  ' + s.cwd));
    if (s.title) out('  ' + s.title);
  });
  return 0;
}
function cmdShow(pos, flags) {
  const s = findSession(pos[0]);
  if (!s) { out('usage: agt show <session-id>   (list them: agt sessions)'); return 1; }
  out(`${c.bold(s.id)} ${c.dim('· ' + s.cwd + ' · ' + s.lane)}`);
  const cut = t => (flags.full || t.length <= 300 ? t : t.slice(0, 300) + c.dim(`… [${t.length} chars, use --full]`));
  for (const m of s.messages) {
    if (m.role === 'user') out(`\n${c.cyan('You')}\n${m.content}`);
    else if (m.role === 'assistant') {
      if (m.content) out(`\n${c.green('Agent')}\n${m.content}`);
      for (const tc of m.tool_calls || []) out(`  ${c.cyan('▸')} ${tc.function.name} ${c.dim(tc.function.arguments || '')}`);
    } else if (m.role === 'tool') out(c.dim('  ← ') + cut(String(m.content)));
  }
  return 0;
}
function cmdChanges(pos, flags) {
  const all = G.readJsonl(P.changes);
  const undone = new Set(all.filter(x => x.action === 'undo' && x.status === 'applied').map(x => x.of));
  const rows = all.filter(x => x.action !== 'undo').slice(-(Number(flags.n) || 15));
  if (!rows.length) { out(c.dim('no changes recorded yet')); return 0; }
  for (const x of rows) {
    const mark = x.status === 'denied' ? sym.fail : x.status === 'failed' ? sym.warn : sym.ok;
    const what = x.action === 'run' ? `$ ${x.command}` : `${x.action} ${x.path}`;
    const tail = x.action === 'run' ? `exit ${x.exit}` : x.status === 'denied' ? 'denied' : `+${x.added} -${x.removed}`;
    out(`${c.dim('#' + x.id)} ${mark} ${what}`);
    out(c.dim(`     ${tail}${undone.has(x.id) ? ' · undone' : ''} · ${G.ago(x.ts)}${x.reason ? ' · reason: ' + x.reason : ''}`));
  }
  return 0;
}
const cmdUndo = (pos, flags) => undoChange(askOnce, pos[0] ? Number(pos[0]) : null, !!flags.force);

async function cmdDoctor() {
  const n = { ok: 0, warn: 0, fail: 0 };
  const say = (lvl, msg, hint) => { n[lvl]++; out(`${sym[lvl]} ${msg}`); if (hint) out(c.dim('    → ' + hint)); };
  out(`${c.bold('agt doctor')} ${c.dim('v' + G.VERSION + ' · ' + G.platformName() + ' · ' + process.arch)}\n`);
  if (Number(process.versions.node.split('.')[0]) >= 18) say('ok', `Node ${process.version}`); else say('fail', `Node ${process.version} is too old (18.17 or newer is needed)`, 'update Node.js');
  if (spawnSync('git', ['--version']).error) say('warn', 'git not found (optional: used for the "is this a repo" check)', G.installHint('git')); else say('ok', 'git available');
  try { G.ensureDirs(); fs.accessSync(P.home, fs.constants.W_OK); say('ok', `data folder ${P.home}`); } catch (e) { say('fail', `cannot write ${P.home}: ${e.message}`); }
  if (CFG_ERR) say('fail', CFG_ERR.message, 'agt config edit');
  else { say('ok', `config ${P.config}`); for (const i of G.validateConfig(CFG)) say('warn', i, 'agt config edit'); }
  for (const [name, p] of Object.entries(CFG.providers)) {
    const raw = process.env[p.keyEnv];
    if (!raw) say('warn', `${p.keyEnv} is not set (${name} is skipped)`, `agt keys set ${name}   (or: agt setup)`);
    else if (raw !== raw.trim() || /^["']|["']$/.test(raw)) say('warn', `${p.keyEnv} has stray quotes or spaces`, `fix it: agt keys set ${name}`);
    else say('ok', `${p.keyEnv} is set (${raw.length} chars, from ${K.SOURCE[p.keyEnv] || 'environment'})`);
  }
  for (const name of Object.keys(CFG.providers)) {
    if (!G.keyOf(CFG, name)) continue;
    const r = await G.probeProvider(CFG, name);
    if (r.ok) say('ok', `${name} reachable, key accepted (${r.ms}ms)`);
    else say('fail', `${name}: ${r.status ? 'HTTP ' + r.status + ' ' : ''}${r.error}`,
      r.status === 401 || r.status === 403 ? 'the key was rejected: create a new one' : r.status === 429 ? 'rate limited: wait, or use the other provider' : r.status ? 'provider error: see the message above' : 'no response: check your internet connection');
  }
  const h = await rget('/health');
  if (!h || !h.json || !h.json.status) say('warn', 'router is not running', 'agt router start (agt chat starts it by itself)');
  else {
    const j = h.json;
    say(j.status === 'ok' ? 'ok' : 'warn', `router ${j.status} on port ${j.port} (pid ${j.pid}, up ${G.dur(j.uptime_s)})`);
    if (j.version !== G.VERSION) say('warn', `router runs v${j.version} but the installed files are v${G.VERSION}`, 'agt router restart');
    for (const [k, s] of Object.entries(j.cooling)) say('warn', `${k} is parked for ${s}s`, 'rate limited or erroring: agt logs router');
  }
  const g = spawnSync('git', ['status', '--porcelain'], { encoding: 'utf8' });
  if (!g.error && g.status === 0) say('ok', `git repo here (${g.stdout.split('\n').filter(Boolean).length} uncommitted files)`);
  else say('warn', 'this folder is not a git repo', 'git init   (makes every agent edit easy to review)');
  if (!process.env.AGT_NO_UPDATE_CHECK) {
    const latest = await latestVersion();
    if (latest && newer(latest, G.VERSION)) say('warn', `update available: ${latest} (you have ${G.VERSION})`, 'agt update');
    else if (latest) say('ok', `up to date (${G.VERSION})`);
  }
  say('ok', `${listSessions().length} saved sessions`);
  out(`\n${n.ok} ok · ${n.warn} warnings · ${n.fail} problems`);
  return n.fail ? 1 : 0;
}

function cmdHelp(pos) {
  if (pos[0] && COMMANDS[pos[0]]) {
    const k = COMMANDS[pos[0]];
    out(`${c.bold('agt ' + pos[0])} - ${k.desc}\n  ${k.usage}`);
    if (k.notes) out('\n' + k.notes);
    return 0;
  }
  out(`${c.bold('agt')} ${c.dim('v' + G.VERSION)}  free-tier coding agent for your terminal\n`);
  out(c.bold('Commands'));
  for (const [n, k] of Object.entries(COMMANDS)) out(`  ${c.cyan(n.padEnd(9))}${k.desc}`);
  out(`\n${c.dim('agt help <command> for details')}`);
  out(`\n${c.bold('Data')}  ${c.dim(P.home)}\n${c.dim('  config.json  keys.env  sessions/  logs/  changes.jsonl  backups/  proposed/')}`);
  return 0;
}

const COMMANDS = {
  chat: { desc: 'talk to the agent in this folder', usage: 'agt chat ["first message"] [--plan|--edit|--lane NAME] [--model NAME] [--keep] [--debug]',
    notes: 'Starts the router if needed and stops it on exit (unless --keep, or it was already running).\nA lane is an ordered failover list. --model (or /model in chat) pins one exact model instead:\nan alias like "fast", or provider/model-id. Every file change asks first: y / n / d / v / s.', run: (p, f) => cmdChat(p, f, false) },
  resume: { desc: 'continue the latest chat for this folder', usage: 'agt resume [session-id]', run: (p, f) => cmdChat([], f, p[0] || true) },
  setup: { desc: 'guided API key setup (works on every OS)', usage: 'agt setup', run: cmdSetup },
  keys: { desc: 'list, set or remove API keys', usage: 'agt keys [list|set <provider>|remove <provider>|path]', notes: 'Keys live in a private file in the data folder; real environment variables always win.\nScripted: echo "$KEY" | agt keys set groq --stdin', run: cmdKeys },
  models: { desc: 'lanes, aliases and available models', usage: 'agt models [provider] [--live]', notes: '--live asks each provider which model ids it offers (uses no tokens).', run: cmdModels },
  router: { desc: 'control the router server', usage: 'agt router start|stop|restart|status|reset|logs', run: cmdRouter },
  health: { desc: 'router health check', usage: 'agt health [--deep] [--json]', notes: '--deep also tests each provider key live (uses no tokens).', run: cmdHealth },
  stats: { desc: 'requests per provider, by day', usage: 'agt stats', run: cmdStats },
  doctor: { desc: 'diagnose problems with setup, keys and router', usage: 'agt doctor', run: cmdDoctor },
  logs: { desc: 'readable router or agent logs', usage: 'agt logs [router|agent] [-n 40] [-f] [--raw]', run: cmdLogs },
  sessions: { desc: 'list saved chats', usage: 'agt sessions [count] | agt sessions rm <id>', run: cmdSessions },
  show: { desc: 'print a saved chat', usage: 'agt show <session-id> [--full]', run: cmdShow },
  changes: { desc: 'what the agent changed or tried to', usage: 'agt changes [-n 15]', run: cmdChanges },
  undo: { desc: 'restore a file the agent changed', usage: 'agt undo [change-id] [--force]', run: cmdUndo },
  config: { desc: 'view or edit lanes, aliases, providers and limits', usage: 'agt config [show|path|edit]', run: cmdConfig },
  update: { desc: 'update to the latest version', usage: 'agt update [--check]', run: cmdUpdate },
  help: { desc: 'this help', usage: 'agt help [command]', run: cmdHelp },
  version: { desc: 'print the version', usage: 'agt version', run: () => { out('agt ' + G.VERSION); return 0; } },
};

(async () => {
  const { flags, pos } = parseArgs(process.argv.slice(2));
  let name = pos.shift();
  if (flags.version) name = 'version';
  if (!name) name = flags.help ? 'help' : 'chat';
  if (CFG_ERR && !['doctor', 'config', 'help', 'version'].includes(name)) {
    out(`${sym.fail} ${CFG_ERR.message}\n${c.dim('  fix: agt config edit   (or: agt doctor)')}`); process.exit(1);
  }
  const cmd = COMMANDS[name];
  if (!cmd) { out(`${sym.fail} unknown command "${name}"\n`); cmdHelp([]); process.exit(1); }
  if (flags.help && name !== 'help') { cmdHelp([name]); return; }
  process.exitCode = (await cmd.run(pos, flags)) || 0;
})().catch(e => { out(`${sym.fail} ${c.red(e.message)}`); if (process.argv.includes('--debug')) out(e.stack); process.exit(1); });
