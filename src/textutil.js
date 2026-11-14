'use strict';
const path = require('path');

// ---------- line endings (Windows files often use CRLF) ----------
const detectEol = text => (/\r\n/.test(text) ? '\r\n' : '\n');
// Give `s` the same line endings as `like`, so edits keep a file's existing style.
const matchEol = (s, like) => (detectEol(like) === '\r\n' ? s.replace(/\r?\n/g, '\r\n') : s.replace(/\r\n/g, '\n'));

// Replace one exact, unique snippet. Works whether the file or the snippet uses CRLF or LF.
function applyEdit(before, oldStr, newStr) {
  const o = matchEol(oldStr, before), n = matchEol(newStr, before);
  const count = before.split(o).length - 1;
  if (count !== 1) return { ok: false, count };
  return { ok: true, after: before.replace(o, () => n) };
}

// ---------- paths ----------
// True when `target` is `root` or lives inside it. Uses path.relative, so it is correct on
// Windows (drive letters, case-insensitive paths) as well as POSIX.
function isInside(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
}

// ---------- unified diff (no external `diff` program, so it works everywhere) ----------
function splitLines(t) {
  if (t === '') return [];
  const lines = t.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function diffOps(a, b) {
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let ea = a.length, eb = b.length;
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) { ea--; eb--; }
  const ops = [];
  for (let i = 0; i < s; i++) ops.push([' ', a[i]]);
  const A = a.slice(s, ea), B = b.slice(s, eb), n = A.length, m = B.length;
  if (n * m > 4e6) {
    // Too large for an exact comparison on a small device: show the middle as one replaced block.
    for (const l of A) ops.push(['-', l]);
    for (const l of B) ops.push(['+', l]);
  } else {
    const W = m + 1;
    const dp = new Uint16Array((n + 1) * W); // the LCS length never exceeds min(n, m) <= 2000 here
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i * W + j] = A[i] === B[j] ? dp[(i + 1) * W + j + 1] + 1 : Math.max(dp[(i + 1) * W + j], dp[i * W + j + 1]);
      }
    }
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (A[i] === B[j]) { ops.push([' ', A[i]]); i++; j++; }
      else if (dp[(i + 1) * W + j] >= dp[i * W + j + 1]) { ops.push(['-', A[i]]); i++; }
      else { ops.push(['+', B[j]]); j++; }
    }
    while (i < n) ops.push(['-', A[i++]]);
    while (j < m) ops.push(['+', B[j++]]);
  }
  for (let i = ea; i < a.length; i++) ops.push([' ', a[i]]);
  return ops;
}

// before === null means "new file". Output follows `diff -u` conventions.
function unifiedDiff(before, after, labelA, labelB, ctx = 3) {
  const ops = diffOps(before === null ? [] : splitLines(before), splitLines(after));
  const changed = [];
  ops.forEach((o, i) => { if (o[0] !== ' ') changed.push(i); });
  if (!changed.length) {
    if (before === null) return '(empty new file)';
    return before !== after ? '(only line endings or the final newline differ)' : '(no differences)';
  }
  const aPos = [], bPos = [];
  let ai = 0, bi = 0;
  for (const o of ops) { aPos.push(ai); bPos.push(bi); if (o[0] !== '+') ai++; if (o[0] !== '-') bi++; }
  const hunks = [];
  let cur = null;
  for (const idx of changed) {
    const lo = Math.max(0, idx - ctx), hi = Math.min(ops.length - 1, idx + ctx);
    if (cur && lo <= cur.hi + 1) cur.hi = Math.max(cur.hi, hi);
    else { cur = { lo, hi }; hunks.push(cur); }
  }
  const range = (start, count) => (count === 1 ? `${start}` : `${start},${count}`);
  const out = [`--- ${labelA}`, `+++ ${labelB}`];
  for (const h of hunks) {
    const part = ops.slice(h.lo, h.hi + 1);
    const aCount = part.filter(o => o[0] !== '+').length, bCount = part.filter(o => o[0] !== '-').length;
    const aStart = aCount === 0 ? aPos[h.lo] : aPos[h.lo] + 1, bStart = bCount === 0 ? bPos[h.lo] : bPos[h.lo] + 1;
    out.push(`@@ -${range(aStart, aCount)} +${range(bStart, bCount)} @@`);
    for (const [t, line] of part) out.push(t + line.replace(/\r$/, ''));
  }
  return out.join('\n') + '\n';
}

module.exports = { detectEol, matchEol, applyEdit, isInside, unifiedDiff };
