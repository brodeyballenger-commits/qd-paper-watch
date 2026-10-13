import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSearchText,
  evaluateRelevance,
  hasCarbonDot,
  isPreprint,
  isQledDevice,
  qledFocus,
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
  assert.deepEqual(r.directions, ['display', 'qled']);
  assert.ok(r.detail.titleQdHits.length > 0);
  assert.ok(r.detail.qledHits.length > 0);
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

test('qledFocus：强信号一条即算（QD-LED / light-emitting diodes / electroluminescence）', () => {
  assert.equal(qledFocus('Blue QD-LEDs with 25% EQE').focus, true);
  assert.deepEqual(qledFocus('Blue QD-LEDs with 25% EQE').strong, ['qled-acronym']);
  assert.equal(qledFocus('Colloidal light-emitting diodes').focus, true);
  assert.equal(qledFocus('Electroluminescence from nanocrystals').focus, true);
  assert.equal(qledFocus('').focus, false);
});

test('qledFocus：只有裸 LED 时不算主方向（挡住「用 LED 灯照射样品」的光伏/探测论文）', () => {
  const pv = 'The cell reaches 12% efficiency under indoor LED illumination (1250 lx).';
  const f = qledFocus(pv);
  assert.equal(f.focus, false);
  assert.deepEqual(f.strong, []);
  assert.deepEqual(f.supporting, ['led-word']);
});

test('qledFocus：裸 LED 加一条辅助信号才放行（microdisplay）', () => {
  const f = qledFocus('Ultra-high-resolution quantum dot microdisplays driven by an LED backplane');
  assert.equal(f.focus, true);
  assert.deepEqual(f.strong, []);
  assert.deepEqual(f.supporting, ['led-word', 'microdisplay']);
});

test('Unicode 连字符（U+2010）归一化后仍能认出 QD-LED', () => {
  // 期刊标题里的 "light‐emitting" 用的是 U+2010，早期词表只写 ASCII 连字符时会被漏掉
  const title = 'Ultrahigh\u2010resolution quantum dot light\u2010emitting diodes';
  assert.equal(isQledDevice({ title }), true);
  const r = evaluateRelevance(paper(title, 'The device shows electroluminescence at 12 V.'));
  assert.equal(r.pass, true, JSON.stringify(r));
  assert.ok(r.directions.includes('qled'), JSON.stringify(r.directions));
});

test('isQledDevice：器件与材料论文区分得开，且对空输入安全', () => {
  assert.equal(isQledDevice({ title: 'Efficient InP Quantum Dot Light-Emitting Diodes' }), true);
  assert.equal(isQledDevice({ title: 'Copper-Catalyzed Cation Exchange in CdSe/ZnSe Nanoplatelets' }), false);
  assert.equal(isQledDevice({}), false);
  assert.equal(isQledDevice(null), false);
});

test('evaluateRelevance：非发光器件论文不会被打上 qled 标签', () => {
  const r = evaluateRelevance(
    paper('PbS Quantum Dot Photodetector with High Detectivity', 'The quantum dot film is used as the absorber; no LED involved.', 'Nature Photonics'),
  );
  assert.equal(r.pass, true, JSON.stringify(r));
  assert.equal(r.directions.includes('qled'), false, JSON.stringify(r.directions));
});
