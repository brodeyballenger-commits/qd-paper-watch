// test/journal-metrics.test.mjs
// 覆盖期刊指标查表与「非研究性条目」排除规则。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CAS_TIER_YEAR,
  JCR_YEAR,
  JOURNAL_METRICS,
  MANUAL_EXCLUDE_DOIS,
  MUST_READ,
  NON_RESEARCH_TITLE_PATTERNS,
  applyJournalMetrics,
  lookupJournal,
  nonResearchReason,
  normalizeVenue,
} from '../src/journal-metrics.mjs';

test('normalizeVenue：解码 HTML 实体、转小写、压缩空白、去尾部标点', () => {
  assert.equal(normalizeVenue('Optics &amp; Laser Technology'), 'optics & laser technology');
  assert.equal(normalizeVenue('  Nano   Letters . '), 'nano letters');
  assert.equal(normalizeVenue('Advanced Materials.'), 'advanced materials');
  assert.equal(normalizeVenue(null), '');
  assert.equal(normalizeVenue(undefined), '');
});

test('normalizeVenue：把各种连字符统一成 ASCII 连字符', () => {
  // U+2010 HYPHEN / U+2013 EN DASH / U+2212 MINUS
  assert.equal(normalizeVenue('Laser \u2010 Photonics Review'), 'laser - photonics review');
  assert.equal(normalizeVenue('A\u2013B'), 'a-b');
  assert.equal(normalizeVenue('A\u2212B'), 'a-b');
});

test('lookupJournal：常见期刊能查到影响因子与分区', () => {
  assert.deepEqual(lookupJournal('Advanced Materials'), {
    name: 'advanced materials',
    impactFactor: 27.4,
    tier: 1,
  });
  assert.equal(lookupJournal('Nature Nanotechnology').impactFactor, 38.1);
  assert.equal(lookupJournal('ACS Nano').impactFactor, 15.8);
  assert.equal(lookupJournal('Applied Physics Letters').impactFactor, 3.5);
});

test('lookupJournal：大小写、空格、HTML 实体都不影响匹配', () => {
  assert.equal(lookupJournal('  NATURE   NANOTECHNOLOGY ').impactFactor, 38.1);
  assert.equal(lookupJournal('Optics &amp; Laser Technology').impactFactor, 5.0);
  assert.equal(lookupJournal('ACS Applied Materials &amp; Interfaces').impactFactor, 8.3);
});

test('lookupJournal：绝不前缀匹配 —— 更长的刊名不能被更短的顶刊吞掉', () => {
  // 这三条是真实踩过的坑：前缀匹配会把它们误判成 IF 27.4 / 24.2 的顶刊
  const advTech = lookupJournal('Advanced Materials Technologies');
  assert.equal(advTech.impactFactor, 6.8);
  assert.notEqual(advTech.impactFactor, JOURNAL_METRICS['advanced materials'].impactFactor);

  const todayNano = lookupJournal('Materials Today Nano');
  assert.equal(todayNano.impactFactor, 3.9);

  const todayComms = lookupJournal('Materials Today Communications');
  assert.equal(todayComms.impactFactor, 3.8);

  // 完全不在表里的刊一律返回 null，不做任何兜底猜测
  assert.equal(lookupJournal('Journal of Fictional Quantum Studies'), null);
  assert.equal(lookupJournal('Some Random Repository'), null);
});

test('lookupJournal：兼容 "同一刊名被拼接" 的脏数据', () => {
  const hit = lookupJournal('Physical review. B./Physical review. B');
  assert.ok(hit);
  assert.equal(hit.name, 'physical review. b');
  assert.equal(hit.impactFactor, 3.7);
});

test('lookupJournal：仓储/机构名不算期刊', () => {
  for (const name of ['Zenodo (CERN European Organization for Nuclear Research)', 'University of Warwick', 'DOAJ (DOAJ: Directory of Open Access Journals)']) {
    assert.equal(lookupJournal(name), null, `${name} 不应被识别为期刊`);
  }
});

test('JOURNAL_METRICS：所有分区与影响因子取值合法', () => {
  for (const [name, metric] of Object.entries(JOURNAL_METRICS)) {
    assert.equal(normalizeVenue(name), name, `表键 ${name} 必须是 normalizeVenue 之后的形式`);
    assert.ok([1, 2, 3].includes(metric.tier), `${name} 的 tier 必须是 1/2/3`);
    assert.equal(typeof metric.impactFactor, 'number');
    assert.ok(metric.impactFactor >= 0, `${name} 的影响因子不能为负`);
  }
  assert.equal(typeof JCR_YEAR, 'number');
  assert.equal(typeof CAS_TIER_YEAR, 'number');
});

test('MUST_READ：规则数值自洽（顶刊门槛高于补足门槛）', () => {
  assert.ok(MUST_READ.windowDays > 0);
  assert.ok(MUST_READ.limit > 0);
  assert.ok(MUST_READ.topMinIf > MUST_READ.fallbackMinIf, '顶刊门槛必须严格高于补足门槛');
  assert.ok(MUST_READ.fallbackMinIf > 0);
});

test('nonResearchReason：评论/勘误/编者按被识别', () => {
  assert.equal(nonResearchReason({ title: 'News and Views: something' }), 'title');
  assert.equal(nonResearchReason({ title: 'Commentary on quantum dots' }), 'title');
  assert.equal(nonResearchReason({ title: 'Erratum: High-efficiency QLED' }), 'title');
  assert.equal(nonResearchReason({ title: 'Correction to "Quantum dot lasers"' }), 'title');
  assert.equal(nonResearchReason({ title: 'Research Highlights' }), 'title');
  assert.equal(nonResearchReason({ title: 'Retraction Note: something' }), 'title');
});

test('nonResearchReason：综述与正常研究论文不误伤', () => {
  assert.equal(nonResearchReason({ title: 'Recent progress in infrared quantum dots for photodetectors' }), null);
  assert.equal(nonResearchReason({ title: 'PbS量子点红外光电探测器研究进展' }), null);
  assert.equal(nonResearchReason({ title: 'High-resolution intrinsically stretchable quantum-dot displays' }), null);
  assert.equal(nonResearchReason({ title: 'Perspective on quantum dot displays' }), null);
});

test('nonResearchReason：手工黑名单里的 DOI 优先级最高', () => {
  const doi = MANUAL_EXCLUDE_DOIS[0];
  assert.equal(nonResearchReason({ doi: doi.toUpperCase(), title: 'A perfectly normal title' }), 'manual');
  assert.equal(nonResearchReason({ doi: '10.1000/normal', title: 'A normal title' }), null);
});

test('applyJournalMetrics：幂等地补标影响因子与分区', () => {
  const papers = [
    { doi: 'a', venue: 'Advanced Materials' },
    { doi: 'b', venue: 'Journal of Fictional Quantum Studies' },
    { doi: 'c', venue: 'Nature Nanotechnology' },
  ];

  const first = applyJournalMetrics(papers);
  assert.equal(first, 2, '只有两条命中期刊表');
  assert.equal(papers[0].journal_if, 27.4);
  assert.equal(papers[0].journal_tier, 1);
  assert.equal(papers[1].journal_if, undefined);
  assert.equal(papers[2].journal_if, 38.1);

  // 再跑一次不应有任何变化
  assert.equal(applyJournalMetrics(papers), 0);
});

test('applyJournalMetrics：期刊信息变了会重算，不再是期刊则清除字段', () => {
  const papers = [
    { doi: 'a', venue: 'Advanced Materials', journal_if: 99, journal_tier: 3 },
    { doi: 'b', venue: 'Not A Journal', journal_if: 12.3, journal_tier: 1 },
  ];
  applyJournalMetrics(papers);
  assert.equal(papers[0].journal_if, 27.4, '旧值应被纠正');
  assert.equal(papers[0].journal_tier, 1);
  assert.equal(papers[1].journal_if, undefined, '查不到就必须清掉，避免展示过期 IF');
  assert.equal(papers[1].journal_tier, undefined);
});

test('NON_RESEARCH_TITLE_PATTERNS：全部是正则对象', () => {
  for (const pattern of NON_RESEARCH_TITLE_PATTERNS) {
    assert.ok(pattern instanceof RegExp);
  }
});
