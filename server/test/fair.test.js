import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildChain, crashPointFromHash, multiplierAt, msForMultiplier, sha256 } from '../src/fair.js';

test('chain links: sha256(game n) == game n-1', () => {
  const c = buildChain('seed', 50);
  for (let i = 1; i < 50; i++) assert.equal(sha256(c[i - 1]), c[i]);
});

test('crash distribution matches (1-edge)/m', () => {
  const c = buildChain('dist', 200000);
  const edge = 0.03;
  const pts = c.map((h) => crashPointFromHash(h, 'salt', edge));
  for (const m of [1.5, 2, 5, 10]) {
    const p = pts.filter((x) => x >= m).length / pts.length;
    assert.ok(Math.abs(p - (1 - edge) / m) < 0.01, `P(>=${m}) = ${p}`);
  }
  assert.ok(pts.every((x) => x >= 1));
});

test('multiplier curve is monotonic and invertible', () => {
  assert.equal(multiplierAt(0), 1);
  for (const m of [1.01, 2, 10, 100]) assert.ok(multiplierAt(msForMultiplier(m)) >= m);
});
