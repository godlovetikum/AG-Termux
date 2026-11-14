'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const T = require('../src/textutil');

// A small unified-diff applier, used to prove that diffs are correct (not just plausible-looking).
function applyDiff(original, diff) {
  const src = original === null || original === '' ? [] : original.split('\n');
  if (src.length && src[src.length - 1] === '') src.pop();
  const lines = diff.split('\n');
  const out = [];
  let pos = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@$/.exec(lines[i]);
    if (!m) continue;
    const aStart = Number(m[2]) === 0 ? Number(m[1]) : Number(m[1]) - 1;
    while (pos < aStart) out.push(src[pos++]);
    for (i++; i < lines.length && !lines[i].startsWith('@@'); i++) {
      const l = lines[i];
      if (l === '' && i === lines.length - 1) break;
      const body = l.slice(1);
      if (l[0] === ' ') { assert.strictEqual(src[pos], body, 'context line must match the original'); out.push(src[pos++]); }
      else if (l[0] === '-') { assert.strictEqual(src[pos], body, 'removed line must match the original'); pos++; }
      else if (l[0] === '+') out.push(body);
    }
    i--;
  }
  while (pos < src.length) out.push(src[pos++]);
  return out.join('\n') + (out.length ? '\n' : '');
}

test('unifiedDiff: simple change has diff -u style headers and hunk', () => {
  const d = T.unifiedDiff('a\nb\nc\n', 'a\nB\nc\n', 'a/x.txt', 'b/x.txt');
  assert.match(d, /^--- a\/x\.txt\n\+\+\+ b\/x\.txt\n@@ -1,3 \+1,3 @@\n a\n-b\n\+B\n c\n$/);
});

test('unifiedDiff: new file, identical files, and final-newline-only changes', () => {
  assert.match(T.unifiedDiff(null, 'x\ny\n', '/dev/null', 'b/n.txt'), /@@ -0,0 \+1,2 @@\n\+x\n\+y\n$/);
  assert.strictEqual(T.unifiedDiff('same\n', 'same\n', 'a', 'b'), '(no differences)');
  assert.match(T.unifiedDiff('x', 'x\n', 'a', 'b'), /only line endings or the final newline/);
  assert.strictEqual(T.unifiedDiff(null, '', 'a', 'b'), '(empty new file)');
});

test('unifiedDiff: far-apart changes make separate hunks, close ones merge', () => {
  const base = Array.from({ length: 40 }, (_, i) => 'line' + i);
  const far = base.slice(); far[2] = 'X'; far[35] = 'Y';
  assert.strictEqual((T.unifiedDiff(base.join('\n') + '\n', far.join('\n') + '\n', 'a', 'b').match(/^@@/gm) || []).length, 2);
  const near = base.slice(); near[10] = 'X'; near[14] = 'Y';
  assert.strictEqual((T.unifiedDiff(base.join('\n') + '\n', near.join('\n') + '\n', 'a', 'b').match(/^@@/gm) || []).length, 1);
});

test('unifiedDiff: random edits round-trip through the applier', () => {
  let seed = 12345;
  const rnd = n => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  for (let round = 0; round < 200; round++) {
    const a = Array.from({ length: rnd(30) }, () => 'w' + rnd(6));
    const b = a.slice();
    for (let k = rnd(5); k > 0; k--) {
      const op = rnd(3), at = rnd(b.length + 1);
      if (op === 0) b.splice(at, 0, 'n' + rnd(9));
      else if (op === 1 && b.length) b.splice(Math.min(at, b.length - 1), 1);
      else if (b.length) b[Math.min(at, b.length - 1)] = 'm' + rnd(9);
    }
    const A = a.length ? a.join('\n') + '\n' : '', B = b.length ? b.join('\n') + '\n' : '';
    if (A === B) continue;
    const d = T.unifiedDiff(A, B, 'a', 'b');
    if (d.startsWith('(')) continue;
    assert.strictEqual(applyDiff(A, d), B, `round ${round}\n${A}\n---\n${B}\n---\n${d}`);
  }
});

test('unifiedDiff: huge unrelated blocks fall back instead of exhausting memory', () => {
  const a = Array.from({ length: 3000 }, (_, i) => 'a' + i).join('\n') + '\n';
  const b = Array.from({ length: 3000 }, (_, i) => 'b' + i).join('\n') + '\n';
  const d = T.unifiedDiff(a, b, 'a', 'b');
  assert.match(d, /@@ -1,3000 \+1,3000 @@/);
});

test('edits keep CRLF files CRLF and LF files LF', () => {
  const crlf = 'one\r\ntwo\r\nthree\r\n';
  const e = T.applyEdit(crlf, 'two\n', 'TWO\nextra\n');
  assert.ok(e.ok);
  assert.strictEqual(e.after, 'one\r\nTWO\r\nextra\r\nthree\r\n');
  const lf = 'one\ntwo\nthree\n';
  assert.strictEqual(T.applyEdit(lf, 'two\r\n', 'TWO\r\n').after, 'one\nTWO\nthree\n');
  assert.deepStrictEqual(T.applyEdit(lf, 'nope', 'x'), { ok: false, count: 0 });
  assert.deepStrictEqual(T.applyEdit('a\na\n', 'a', 'x'), { ok: false, count: 2 });
  assert.strictEqual(T.matchEol('a\nb', crlf), 'a\r\nb');
});

test('isInside works for nested, sibling, parent and prefix-lookalike paths', () => {
  const root = path.resolve('/tmp/proj');
  assert.ok(T.isInside(root, root));
  assert.ok(T.isInside(root, path.join(root, 'a', 'b.txt')));
  assert.ok(!T.isInside(root, path.resolve('/tmp/proj2/x')));
  assert.ok(!T.isInside(root, path.resolve('/tmp')));
  assert.ok(!T.isInside(root, path.join(root, '..', 'secret')));
  if (process.platform === 'win32') assert.ok(!T.isInside('C:\\proj', 'D:\\proj\\x'));
});
