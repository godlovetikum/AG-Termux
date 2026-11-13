#!/usr/bin/env node
'use strict';
/*
 * ag installer for Termux (also works on any Linux/macOS with Node 18+).
 * Zero dependencies. Run from the repo folder:   node install.js
 *
 *   node install.js [--dir <path>] [--no-shell] [--no-keys] [--dry-run]
 *   node install.js --uninstall [--purge]
 *
 * What it does (and nothing else):
 *   1. copies src/*.js           -> ~/ag            (the program)
 *   2. writes a launcher         -> $PREFIX/bin/ag  (so `ag` works in every session)
 *   3. creates ~/.keys template  -> only if missing (chmod 600)
 *   4. adds `source ~/.keys`     -> to ~/.bashrc, once, and removes an old `alias ag=` line
 * It never touches your existing ~/.ag/ data or config.json, and never reads your keys.
 */
const fs = require('fs'), path = require('path'), os = require('os');
const { spawnSync } = require('child_process');

const argv = process.argv.slice(2);
const flag = n => argv.includes('--' + n);
const opt = n => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null; };

const TTY = process.stdout.isTTY && !process.env.NO_COLOR;
const col = (n, s) => (TTY ? `\x1b[${n}m${s}\x1b[0m` : s);
const ok = m => console.log(col(32, '✓') + ' ' + m);
const info = m => console.log(col(36, '•') + ' ' + m);
const warn = m => console.log(col(33, '!') + ' ' + m);
const fail = m => { console.error(col(31, '✗') + ' ' + m); process.exit(1); };
const DRY = flag('dry-run');
const act = (what, fn) => { if (DRY) return info('[dry-run] ' + what); fn(); };

const HOME = os.homedir();
const PREFIX = process.env.PREFIX || '';
const IS_TERMUX = /com\.termux/.test(PREFIX) || !!process.env.TERMUX_VERSION;
const SRC = path.join(__dirname, 'src');
const DEST = path.resolve(opt('dir') || path.join(HOME, 'ag'));
const BIN_DIR = IS_TERMUX && PREFIX ? path.join(PREFIX, 'bin') : path.join(HOME, '.local', 'bin');
const LAUNCHER = path.join(BIN_DIR, 'ag');
const KEYS = path.join(HOME, '.keys');
const BASHRC = path.join(HOME, '.bashrc');
const FILES = ['common.js', 'router.js', 'ag.js'];
const MARK = '# added by ag installer';

function uninstall() {
  console.log(col(1, 'ag uninstall') + '\n');
  act(`remove ${DEST}`, () => fs.rmSync(DEST, { recursive: true, force: true }));
  act(`remove ${LAUNCHER}`, () => fs.rmSync(LAUNCHER, { force: true }));
  ok(`removed program (${DEST}) and launcher`);
  if (flag('purge')) {
    const data = process.env.AG_HOME || path.join(HOME, '.ag');
    act(`remove ${data}`, () => fs.rmSync(data, { recursive: true, force: true }));
    ok(`removed data folder ${data} (sessions, logs, config)`);
  } else info(`kept your data in ${process.env.AG_HOME || path.join(HOME, '.ag')} (add --purge to delete it)`);
  info('your ~/.keys and ~/.bashrc were not changed');
}

function main() {
  console.log(col(1, 'ag installer') + (IS_TERMUX ? col(2, '  (Termux detected)') : '') + (DRY ? col(33, '  DRY RUN') : '') + '\n');

  if (Number(process.versions.node.split('.')[0]) < 18) fail(`Node ${process.version} is too old. Run: pkg upgrade nodejs`);
  ok(`Node ${process.version}`);
  for (const f of FILES) if (!fs.existsSync(path.join(SRC, f))) fail(`missing ${path.join(SRC, f)}. Run this from the repo folder (the one with src/).`);
  if (!IS_TERMUX) warn('not Termux: using ~/.local/bin for the launcher (make sure it is on your PATH)');

  // 1. program files
  act(`copy ${FILES.join(', ')} -> ${DEST}`, () => {
    fs.mkdirSync(DEST, { recursive: true });
    for (const f of FILES) fs.copyFileSync(path.join(SRC, f), path.join(DEST, f));
    fs.chmodSync(path.join(DEST, 'ag.js'), 0o755);
  });
  ok(`program files in ${DEST}`);

  // 2. launcher
  const sh = IS_TERMUX && PREFIX ? path.join(PREFIX, 'bin', 'sh') : '/bin/sh';
  const script = `#!${sh}\n${MARK}\nexec "${process.execPath}" "${path.join(DEST, 'ag.js')}" "$@"\n`;
  act(`write launcher ${LAUNCHER}`, () => { fs.mkdirSync(BIN_DIR, { recursive: true }); fs.writeFileSync(LAUNCHER, script, { mode: 0o755 }); fs.chmodSync(LAUNCHER, 0o755); });
  ok(`launcher ${LAUNCHER}`);

  // 3. keys template
  if (flag('no-keys')) info('skipped ~/.keys (--no-keys)');
  else if (fs.existsSync(KEYS)) ok('~/.keys already exists (left untouched)');
  else {
    act('create ~/.keys template', () => fs.writeFileSync(KEYS, [
      '# API keys for ag. Fill in the ones you have; leave the rest empty.',
      '# Keep this file private (chmod 600) and out of any git repo.',
      'export GEMINI_API_KEY=""   # https://aistudio.google.com',
      'export GROQ_API_KEY=""     # https://console.groq.com',
      '',
    ].join('\n'), { mode: 0o600 }));
    ok('created ~/.keys template (fill in your keys: nano ~/.keys)');
  }

  // 4. shell setup
  if (flag('no-shell')) info('skipped ~/.bashrc (--no-shell)');
  else {
    let rc = '';
    try { rc = fs.readFileSync(BASHRC, 'utf8'); } catch {}
    let next = rc;
    if (/^alias ag=/m.test(next)) { next = next.replace(/^alias ag=.*\n?/gm, ''); ok('removed the old "alias ag=" line from ~/.bashrc (the launcher replaces it)'); }
    if (!/\.keys/.test(next)) { next += (next && !next.endsWith('\n') ? '\n' : '') + `[ -f ~/.keys ] && source ~/.keys ${MARK}\n`; ok('~/.bashrc now loads ~/.keys'); }
    else ok('~/.bashrc already loads ~/.keys');
    if (next !== rc) act('update ~/.bashrc', () => fs.writeFileSync(BASHRC, next));
  }

  // 5. required tools
  for (const [bin, pkg, why] of [['git', 'git', 'change tracking'], ['diff', 'diffutils', 'edit previews']]) {
    if (spawnSync(bin, ['--version']).error) warn(`${bin} not found (${why}). Install: pkg install ${pkg}`);
  }

  console.log(`\n${col(1, 'Done.')} Next steps:
  1. Add your keys:        nano ~/.keys
  2. Load them now:        source ~/.keys
  3. Check everything:     ag doctor
  4. Use it in a project:  cd ~/Projects/<your-project> && ag
`);
  if (flag('doctor') && !DRY) spawnSync(process.execPath, [path.join(DEST, 'ag.js'), 'doctor'], { stdio: 'inherit' });
}

try { flag('uninstall') ? uninstall() : main(); } catch (e) { fail(e.message); }
