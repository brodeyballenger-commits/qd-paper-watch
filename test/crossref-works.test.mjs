import test from 'node:test';
import assert from 'node:assert/strict';
import { CROSSREF_SELECT, buildCrossrefWorksUrl, mapCrossrefItem } from '../src/crossref-works.mjs';

test('CROSSREF_SELECT 不含 subtype（带 subtype 会让 Crossref 直接回 400）', () => {
  assert.equal(CROSSREF_SELECT.includes('subtype'), false);
  for (const field of ['DOI', 'title', 'container-title', 'ISSN', 'published', 'type', 'URL']) {
    assert.ok(CROSSREF_SELECT.includes(field), `select 里应该有 ${field}`);
  }
});

test('buildCrossrefWorksUrl：只找期刊论文，并且必须同时给上界（否则未来日期垃圾会排最前）', () => {
  const url = new URL(buildCrossrefWorksUrl({ query: 'quantum dot light-emitting diode', fromDate: '2026-08-01', toDate: '2026-08-31', rows: 100, offset: 200 }));
  assert.equal(url.origin + url.pathname, 'https://api.crossref.org/works');
  assert.equal(url.searchParams.get('query.title'), 'quantum dot light-emitting diode');
  assert.equal(url.searchParams.get('rows'), '100');
  assert.equal(url.searchParams.get('offset'), '200');

  const filter = url.searchParams.get('filter');
  assert.match(filter, /type:journal-article/);
  assert.match(filter, /from-pub-date:2026-08-01/);
  assert.match(filter, /until-pub-date:2026-08-31/);
  assert.equal(url.searchParams.get('select'), CROSSREF_SELECT);
});

test('buildCrossrefWorksUrl：没有指定上界时不会凭空造一个', () => {
  const url = new URL(buildCrossrefWorksUrl({ query: 'q', fromDate: '2026-08-01' }));
  assert.equal(url.searchParams.get('filter'), 'type:journal-article,from-pub-date:2026-08-01');
});

test('mapCrossrefItem：映射期刊论文元数据', () => {
  const mapped = mapCrossrefItem({
    DOI: '10.1063/5.0000001',
    title: ['A Miniaturized Synaptic Quantum Dot Light-Emitting Diode'],
    'container-title': ['Applied Physics Reviews'],
    ISSN: ['1931-9401'],
    published: { 'date-parts': [[2026, 8, 5]] },
    type: 'journal-article',
    author: [
      { given: 'Alice', family: 'Alpha' },
      { given: 'Bob', family: 'Beta' },
      { given: 'Carol', family: 'Gamma' },
      { given: 'Dave', family: 'Delta' },
    ],
  });

  assert.equal(mapped.doi, '10.1063/5.0000001');
  assert.equal(mapped.title, 'A Miniaturized Synaptic Quantum Dot Light-Emitting Diode');
  assert.equal(mapped.venue, 'Applied Physics Reviews');
  assert.equal(mapped.issn_l, '1931-9401');
  assert.equal(mapped.pub_date, '2026-08-05');
  assert.equal(mapped.pub_year, 2026);
  assert.equal(mapped.type, 'journal-article');
  assert.equal(mapped.source_type, 'journal');
  assert.deepEqual(mapped.sources, ['crossref']);
  assert.deepEqual(mapped.authors, ['Alice Alpha', 'Bob Beta', 'Carol Gamma', 'et al.']);
});

test('mapCrossrefItem：月份/日缺失时补 1，无 DOI 返回 null', () => {
  const mapped = mapCrossrefItem({ DOI: '10.1000/xyz', title: ['T'], published: { 'date-parts': [[2026]] } });
  assert.equal(mapped.pub_date, '2026-01-01');
  assert.equal(mapCrossrefItem({ title: ['no doi'] }), null);
});

test('mapCrossrefItem：清洗 JSTOR/Crossref 的 JATS 摘要', () => {
  const long = '<jats:p>We demonstrate a quantum dot light-emitting diode with a record external quantum efficiency of 30%.</jats:p>';
  const mapped = mapCrossrefItem({ DOI: '10.1000/abc', 'container-title': ['X'], abstract: long, published: { 'date-parts': [[2026, 8, 5]] } });
  assert.equal(mapped.abstract, 'We demonstrate a quantum dot light-emitting diode with a record external quantum efficiency of 30%.');
  assert.equal(mapped.abstract_source, 'crossref');
  assert.equal(mapped.abstract.includes('<jats:p>'), false);
});
