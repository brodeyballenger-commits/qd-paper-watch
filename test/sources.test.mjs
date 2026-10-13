import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SOURCES } from '../src/config.mjs';
import { dedupeCandidates, resolveSources } from '../src/sources.mjs';

test('resolveSources：不传就用默认源，且没有 SERPAPI_KEY 时不掺入 Google 学术', () => {
  const original = process.env.SERPAPI_KEY;
  delete process.env.SERPAPI_KEY;
  try {
    assert.deepEqual(resolveSources(null), DEFAULT_SOURCES);
    assert.deepEqual(resolveSources('openalex'), ['openalex']);
    assert.deepEqual(resolveSources('openalex, crossref ,openalex'), ['openalex', 'crossref']);
    assert.deepEqual(resolveSources(['arxiv', 'semanticscholar']), ['arxiv', 'semanticscholar']);
  } finally {
    if (original !== undefined) process.env.SERPAPI_KEY = original;
  }
});

test('resolveSources：配了 SERPAPI_KEY 就自动带上 scholar，未知源名直接报错', () => {
  const original = process.env.SERPAPI_KEY;
  process.env.SERPAPI_KEY = 'test-key';
  try {
    assert.deepEqual(resolveSources(null), [...DEFAULT_SOURCES, 'scholar']);
    // 显式指定时完全按用户说的来
    assert.deepEqual(resolveSources('openalex'), ['openalex']);
  } finally {
    if (original === undefined) delete process.env.SERPAPI_KEY;
    else process.env.SERPAPI_KEY = original;
  }

  assert.throws(() => resolveSources('openalex,nope'), /未知数据源：nope/);
  assert.throws(() => resolveSources(','), /至少要启用一个数据源/);
});

test('dedupeCandidates：同 DOI 合并，sources 取并集，摘要留更长的那份', () => {
  const merged = dedupeCandidates([
    { doi: '10.1002/a', title: 'Quantum Dot LED', sources: ['crossref'], venue: 'Advanced Materials', abstract: 'short', abstract_source: 'crossref' },
    { doi: '10.1002/a', title: 'Quantum Dot LED', sources: ['semanticscholar'], abstract: 'a much longer abstract body', abstract_source: 'semanticscholar', cited_by_count: 5 },
  ]);

  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].sources, ['crossref', 'semanticscholar']);
  assert.equal(merged[0].abstract, 'a much longer abstract body');
  assert.equal(merged[0].abstract_source, 'semanticscholar');
  assert.equal(merged[0].cited_by_count, 5);
});

test('dedupeCandidates：同标题不同 DOI 视为同一篇，预印本 DOI 让位给期刊 DOI', () => {
  const merged = dedupeCandidates([
    {
      doi: '10.48550/arXiv.2501.00001',
      title: 'Quantum Dot LEDs with Record External Quantum Efficiency',
      venue: 'arXiv (Cornell University)',
      source_type: 'repository',
      sources: ['openalex'],
    },
    {
      doi: '10.1002/adma.202500001',
      title: 'Quantum Dot LEDs with Record External Quantum Efficiency',
      venue: 'Advanced Materials',
      source_type: 'journal',
      type: 'journal-article',
      sources: ['crossref'],
    },
  ]);

  assert.equal(merged.length, 1);
  // DOI 是记录的身份证，绝不能停在预印本上
  assert.equal(merged[0].doi, '10.1002/adma.202500001');
  assert.equal(merged[0].doi_url, 'https://doi.org/10.1002/adma.202500001');
  assert.equal(merged[0].venue, 'Advanced Materials'); // 预印本仓储名不能盖住期刊名
  assert.equal(merged[0].source_type, 'journal');
  assert.equal(merged[0].type, 'journal-article');
  assert.deepEqual(merged[0].sources, ['openalex', 'crossref']);
  assert.deepEqual(merged[0].alt_dois, ['10.48550/arxiv.2501.00001']); // DOI 统一小写
});

test('dedupeCandidates：标题不同、DOI 不同就不合并；缺 DOI 或缺标题的候选被丢掉', () => {
  const merged = dedupeCandidates([
    { doi: '10.1002/a', title: 'Paper A' },
    { doi: '10.1002/b', title: 'Paper B' },
    { doi: '', title: 'No DOI' },
    { doi: '10.1002/c', title: '' },
    null,
  ]);

  assert.deepEqual(merged.map((m) => m.doi).sort(), ['10.1002/a', '10.1002/b']);
  // 顺手补上 doi_url
  assert.equal(merged[0].doi_url, 'https://doi.org/10.1002/a');
});

test('dedupeCandidates：合并后按新 DOI 建索引，同一标题的第三条也能并进来', () => {
  const merged = dedupeCandidates([
    { doi: '10.48550/arXiv.1', title: 'Same Title', venue: 'arXiv', sources: ['openalex'] },
    { doi: '10.1002/journal', title: 'Same Title', venue: 'Advanced Materials', sources: ['crossref'] },
    { doi: '10.9999/third', title: 'Same Title', venue: 'Some Journal', sources: ['semanticscholar'] },
  ]);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].doi, '10.1002/journal');
  assert.deepEqual(merged[0].sources, ['openalex', 'crossref', 'semanticscholar']);
  assert.deepEqual([...merged[0].alt_dois].sort(), ['10.48550/arxiv.1', '10.9999/third']);
});
