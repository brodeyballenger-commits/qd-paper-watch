import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  dayDiff,
  daysBefore,
  doiUrl,
  isoDate,
  normalizeDoi,
  normalizeTitle,
  sha256,
  stripMarkup,
  truncate,
} from '../src/util.mjs';

test('normalizeDoi 把各种写法收敛成小写裸 DOI', () => {
  assert.equal(normalizeDoi('https://doi.org/10.1021/acs.nanolett.4b00001'), '10.1021/acs.nanolett.4b00001');
  assert.equal(normalizeDoi('http://dx.doi.org/10.1021/ABC'), '10.1021/abc');
  assert.equal(normalizeDoi('doi:10.1038/s41565-024-01234-5'), '10.1038/s41565-024-01234-5');
  assert.equal(normalizeDoi('  10.1002/adma.202401234.  '), '10.1002/adma.202401234');
  assert.equal(normalizeDoi('/10.1063/5.0000001'), '10.1063/5.0000001');
});

test('normalizeDoi 拒绝无效输入', () => {
  assert.equal(normalizeDoi(''), null);
  assert.equal(normalizeDoi(null), null);
  assert.equal(normalizeDoi('not-a-doi'), null);
  assert.equal(normalizeDoi('10.1234'), null);
});

test('doiUrl 生成可点击链接', () => {
  assert.equal(doiUrl('10.1/a'), 'https://doi.org/10.1/a');
  assert.equal(doiUrl(null), null);
});

test('normalizeTitle 忽略大小写、标点与重音，用于同一论文判重', () => {
  const a = normalizeTitle('Efficient Quantum-Dot LEDs: A Review!');
  const b = normalizeTitle('efficient quantum dot leds a review');
  assert.equal(a, b);
  assert.equal(normalizeTitle('Über CdSe'), normalizeTitle('Uber CdSe'));
  assert.equal(normalizeTitle(''), '');
  assert.equal(normalizeTitle(undefined), '');
});

test('sha256 稳定且区分内容', () => {
  assert.equal(sha256('abc'), sha256('abc'));
  assert.notEqual(sha256('abc'), sha256('abd'));
  assert.equal(sha256(null), sha256(''));
});

test('isoDate / daysBefore / dayDiff', () => {
  const from = new Date('2026-10-13T05:00:00Z');
  assert.equal(isoDate(from), '2026-10-13');
  assert.equal(daysBefore(14, from), '2026-09-29');
  assert.equal(dayDiff('2026-09-29', '2026-10-13'), 14);
  assert.equal(dayDiff('2026-10-13', '2026-09-29'), -14);
  assert.equal(dayDiff('bogus', '2026-10-13'), Infinity);
});

test('stripMarkup 去掉标签与实体', () => {
  assert.equal(stripMarkup('<jats:p>Hello&nbsp;<b>world</b></jats:p>'), 'Hello world');
  assert.equal(stripMarkup('a &amp; b &lt;c&gt;'), 'a & b <c>');
  assert.equal(stripMarkup('x &#215; y'), 'x × y');
  assert.equal(stripMarkup('<script>alert(1)</script>safe'), 'safe');
  assert.equal(stripMarkup(null), '');
});

test('truncate 超长时截断且不切断单词', () => {
  assert.equal(truncate('short', 100), 'short');
  const long = 'word '.repeat(100);
  const out = truncate(long, 50);
  assert.ok(out.length <= 51, out);
  assert.ok(out.endsWith('…'));
});
