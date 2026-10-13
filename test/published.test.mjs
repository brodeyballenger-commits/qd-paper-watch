import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hasPreprintDoi,
  hasPreprintVenue,
  isPublishedWork,
  applyPublishedGate,
  applyPublishedFieldsToLedger,
} from '../src/published.mjs';

test('hasPreprintDoi 认得预印本仓储的 DOI 前缀', () => {
  assert.equal(hasPreprintDoi('10.48550/arXiv.2501.00001'), true);
  assert.equal(hasPreprintDoi('10.2139/ssrn.4123456'), true);
  assert.equal(hasPreprintDoi('10.5281/zenodo.1234567'), true);
  assert.equal(hasPreprintDoi('10.1002/adma.202500001'), false);
  assert.equal(hasPreprintDoi(''), false);
  assert.equal(hasPreprintDoi(null), false);
});

test('hasPreprintVenue 认得仓储类来源名', () => {
  assert.equal(hasPreprintVenue('arXiv (Cornell University)'), true);
  assert.equal(hasPreprintVenue('Research Square'), true);
  assert.equal(hasPreprintVenue('Advanced Materials'), false);
  assert.equal(hasPreprintVenue(null), false);
});

test('isPublishedWork：Crossref 的 journal-article 算已见刊', () => {
  const v = isPublishedWork({ doi: '10.1002/adma.202500001', sources: ['crossref'], type: 'journal-article' });
  assert.deepEqual(v, { published: true, published_source: 'crossref', reason: null });
});

test('isPublishedWork：Semantic Scholar 有期刊名算已见刊（publicationTypes 缺失也放行）', () => {
  const v = isPublishedWork({
    doi: '10.1038/s41566-026-00001-1',
    sources: ['semanticscholar'],
    venue: 'Nature Photonics',
    type: 'article',
  });
  assert.equal(v.published, true);
  assert.equal(v.published_source, 'semanticscholar');
});

test('isPublishedWork：OpenAlex 的 source_type=journal 算已见刊', () => {
  const v = isPublishedWork({ doi: '10.1016/j.cej.2026.181979', sources: ['openalex'], source_type: 'journal', type: 'article' });
  assert.equal(v.published, true);
  assert.equal(v.published_source, 'openalex');
});

test('isPublishedWork：来源已自行解析出期刊版本时直接放行', () => {
  const v = isPublishedWork({ doi: '10.1021/jacs.5c13973', published: true, published_source: 'semanticscholar' });
  assert.equal(v.published, true);
  assert.equal(v.published_source, 'semanticscholar');
});

test('isPublishedWork：预印本 DOI / 预印本 venue / 无 DOI 都会被拒', () => {
  assert.equal(isPublishedWork({ doi: '10.48550/arXiv.2501.00001', sources: ['openalex'], source_type: 'journal' }).reason, 'preprint-doi');
  const byVenue = isPublishedWork({ doi: '10.1002/x', sources: ['openalex'], venue: 'arXiv (Cornell University)', source_type: 'journal' });
  assert.equal(byVenue.reason, 'preprint-venue');
  assert.equal(isPublishedWork({ title: 'no doi' }).reason, 'no-doi');
});

test('isPublishedWork：识别不出期刊证据时给 no-journal-evidence', () => {
  const v = isPublishedWork({ doi: '10.9999/unknown', sources: ['openalex'], source_type: 'repository', venue: 'Unknown Preprint Server' });
  assert.deepEqual(v, { published: false, published_source: null, reason: 'no-journal-evidence' });
});

test('applyPublishedGate 只放行见刊记录并按原因分组计数', () => {
  const raws = [
    { doi: '10.1002/a', sources: ['crossref'], type: 'journal-article' },
    { doi: '10.48550/arXiv.1', sources: ['openalex'], source_type: 'journal' },
    { doi: '10.9999/b', sources: ['openalex'], source_type: 'repository' },
    { doi: '10.9999/c', sources: ['openalex'], venue: 'bioRxiv', source_type: 'journal' },
  ];
  const gate = applyPublishedGate(raws);
  assert.equal(gate.published.length, 1);
  assert.equal(gate.published[0].published, true);
  assert.equal(gate.published[0].published_source, 'crossref');
  assert.equal(gate.dropped, 3);
  assert.equal(gate.stats.get('preprint-doi'), 1);
  assert.equal(gate.stats.get('no-journal-evidence'), 1);
  assert.equal(gate.stats.get('preprint-venue'), 1);
});

test('applyPublishedFieldsToLedger 给存量记录补字段，且幂等', () => {
  const papers = [
    { doi: '10.1002/a', is_preprint: false },
    { doi: '10.48550/arXiv.1', is_preprint: true },
    { doi: '10.1002/b', is_preprint: false, abstract_source: 'crossref' },
    { doi: '10.1002/c', is_preprint: false, sources: ['openalex', 'arxiv'], published: true, published_source: 'semanticscholar' },
  ];

  const changed = applyPublishedFieldsToLedger(papers);
  assert.equal(changed, 3); // 第 4 条本来就有完整字段，不该被改

  assert.deepEqual(papers[0].sources, ['openalex']);
  assert.equal(papers[0].published, true);
  assert.deepEqual(papers[1].sources, ['openalex']);
  assert.equal(papers[1].published, false); // 预印本不降级为已见刊
  assert.deepEqual(papers[2].sources, ['openalex', 'crossref']);
  assert.deepEqual(papers[3].sources, ['openalex', 'arxiv']);
  assert.equal(papers[3].published_source, 'semanticscholar');

  assert.equal(applyPublishedFieldsToLedger(papers), 0);
});
