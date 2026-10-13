import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSearchText,
  evaluateRelevance,
  hasCarbonDot,
  isPreprint,
  stripCarbonDots,
} from '../src/relevance.mjs';

const paper = (title, abstract, venue = 'Nature Photonics') => ({ title, abstract, venue });

test('pass：标题与摘要都站在量子点器件上', () => {
  const r = evaluateRelevance(
    paper(
      'Efficient Quantum Dot Light-Emitting Diodes with Long Lifetime',
      'We demonstrate quantum dot light-emitting diodes with external quantum efficiency of 25%.',
    ),
  );
  assert.equal(r.pass, true, JSON.stringify(r));
  assert.equal(r.reason, null);
  assert.deepEqual(r.directions, ['display']);
  assert.ok(r.detail.titleQdHits.length > 0);
});

test('drop carbon-dot：碳点不是量子点，且整体抹掉后不再有量子点证据', () => {
  const r = evaluateRelevance(paper('Highly Fluorescent Carbon Dots for Bioimaging', 'Carbon dots were prepared.'));
  assert.equal(r.pass, false);
  assert.equal(r.reason, 'carbon-dot');
  assert.equal(r.detail.carbonDot, true);
});

test('drop carbon-dot：carbon quantum dots 也算碳点', () => {
  const r = evaluateRelevance(paper('Carbon Quantum Dot Based White LEDs', 'A carbon quantum dot phosphor is used.'));
  assert.equal(r.pass, false);
  assert.equal(r.reason, 'carbon-dot');
});

test('CdS 不会被误判成碳点（故意不使用 \\bCDs\\b）', () => {
  const r = evaluateRelevance(paper('CdS Quantum Dot Photodetectors with High Detectivity', 'A CdS quantum dot film shows detectivity of 1e12 Jones.'));
  assert.equal(r.detail.carbonDot, false);
  assert.equal(r.pass, true, JSON.stringify(r));
});

test('drop no-qd-in-title：摘要顺口提一句 quantum dot 不算对口', () => {
  const r = evaluateRelevance(
    paper('High-Responsivity Infrared Photodetectors with Record Detectivity', 'The absorber is a quantum dot layer.'),
  );
  assert.equal(r.pass, false);
  assert.equal(r.reason, 'no-qd-in-title');
  assert.ok(r.detail.qdHits.length > 0);
  assert.equal(r.detail.titleQdHits.length, 0);
});

test('drop no-device-signal：纯合成/材料论文不进站', () => {
  const r = evaluateRelevance(paper('Quantum Dot Synthesis via Hot Injection', 'We synthesized quantum dots with narrow size distribution.'));
  assert.equal(r.pass, false);
  assert.equal(r.reason, 'no-device-signal');
});

test('drop noise：只有弱器件信号时，化学传感论文被挡掉', () => {
  const r = evaluateRelevance(
    paper('Quantum Dot Sensors for Glucose Detection in Serum', 'A sensing platform for glucose in real samples.'),
  );
  assert.equal(r.pass, false);
  assert.ok(r.reason.startsWith('noise:'), r.reason);
  assert.match(r.reason, /chem-sensing/);
});

test('强器件信号可以豁免噪音词（QD-LED 摘要里出现 biomedical 语境不算噪音）', () => {
  const r = evaluateRelevance(
    paper(
      'Quantum Dot Light-Emitting Diodes for Wearable Displays',
      'The device enables in vivo imaging compatible displays with 30% EQE.',
    ),
  );
  assert.equal(r.pass, true, JSON.stringify(r));
  assert.ok(r.detail.noiseHits.length > 0);
  assert.ok(r.detail.strongDeviceHits.length > 0);
});

test('weak-qd 兜底：摘要缺失时用材料体系 + 强器件信号救回真正对口的论文', () => {
  const noAbstract = { title: 'Optically Active Single Hole Spin in ZnSe Photodetectors', abstract: null, venue: 'Physical Review Letters' };
  const r = evaluateRelevance(noAbstract);
  assert.equal(r.pass, true, JSON.stringify(r));
  assert.match(r.reason, /^weak-qd:/);
  assert.ok(r.detail.weakQdHits.includes('material'));
});

test('weak-qd 兜底只在无摘要时启用', () => {
  const r = evaluateRelevance(paper('ZnSe Photodetectors with High Detectivity', 'We grew ZnSe layers by molecular beam epitaxy.'));
  assert.equal(r.pass, false);
  assert.equal(r.reason, 'no-quantum-dot');
});

test('buildSearchText 拼接标题、摘要与期刊', () => {
  assert.equal(buildSearchText({ title: 'A', abstract: 'B', venue: 'C' }), 'A \n B \n C');
  assert.equal(buildSearchText({}), '');
  assert.equal(buildSearchText(null), '');
});

test('stripCarbonDots / hasCarbonDot 反复调用结果稳定（带 g 的正则有 lastIndex 状态）', () => {
  const text = 'Carbon dots and quantum dots';
  assert.equal(stripCarbonDots(text), '  and quantum dots');
  assert.equal(stripCarbonDots(text), '  and quantum dots');
  assert.equal(hasCarbonDot(text), true);
  assert.equal(hasCarbonDot(text), true);
  assert.equal(hasCarbonDot('quantum dots only'), false);
  assert.equal(hasCarbonDot('quantum dots only'), false);
});

test('isPreprint 识别仓储版本与预印本站点', () => {
  assert.equal(isPreprint({ venue: 'arXiv (Cornell University)' }), true);
  assert.equal(isPreprint({ venue: 'Nature Photonics', source_type: 'repository' }), true);
  assert.equal(isPreprint({ venue: 'Nature Photonics', source_type: 'journal' }), false);
  assert.equal(isPreprint({}), false);
});
