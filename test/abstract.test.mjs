import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeCrossrefAbstract, restoreAbstract } from '../src/abstract.mjs';

test('restoreAbstract 按 position 还原词序（不是按对象键顺序）', () => {
  const inverted = {
    dots: [3],
    Quantum: [0],
    are: [2],
    small: [4],
    efficient: [1],
  };
  assert.equal(restoreAbstract(inverted), 'Quantum efficient are dots small');
});

test('restoreAbstract 处理多位置与重复词', () => {
  const inverted = {
    quantum: [0, 4],
    dots: [1, 5],
    light: [2],
    emitters: [3],
    bright: [6],
  };
  assert.equal(restoreAbstract(inverted), 'quantum dots light emitters quantum dots bright');
});

test('restoreAbstract 无有效输入时返回 null', () => {
  assert.equal(restoreAbstract(null), null);
  assert.equal(restoreAbstract(undefined), null);
  assert.equal(restoreAbstract({}), null);
  assert.equal(restoreAbstract({ a: 'nope' }), null);
  assert.equal(restoreAbstract({ a: [-1, 1.5] }), null);
});

test('restoreAbstract 会清掉残留的 HTML 标签', () => {
  const inverted = { '<jats:p>Abstract': [0], dots: [1], '</jats:p>': [2] };
  const out = restoreAbstract(inverted);
  assert.ok(out && !out.includes('<'), out);
});

test('normalizeCrossrefAbstract 去标签并剥掉开头的 Abstract', () => {
  const raw = '<jats:p>Abstract</jats:p><jats:p>We report colloidal quantum dot light-emitting diodes with record efficiency and long lifetime.</jats:p>';
  const out = normalizeCrossrefAbstract(raw);
  assert.ok(out.startsWith('We report colloidal quantum dot'), out);
  assert.ok(!out.includes('<'), out);
});

test('normalizeCrossrefAbstract 太短或非字符串时返回 null', () => {
  assert.equal(normalizeCrossrefAbstract('<jats:p>Too short</jats:p>'), null);
  assert.equal(normalizeCrossrefAbstract(''), null);
  assert.equal(normalizeCrossrefAbstract(null), null);
  assert.equal(normalizeCrossrefAbstract(42), null);
});
