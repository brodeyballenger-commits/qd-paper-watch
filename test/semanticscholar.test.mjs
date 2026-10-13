import test from 'node:test';
import assert from 'node:assert/strict';
import { S2_BATCH_SIZE } from '../src/config.mjs';
import { buildBulkSearchUrl, mapS2Paper, s2Headers, s2LookupBatch } from '../src/semanticscholar.mjs';

test('buildBulkSearchUrl 只检索期刊论文、按发表日期倒序、带上起始日期', () => {
  const url = new URL(buildBulkSearchUrl({ query: 'quantum dot light-emitting diode', since: '2026-08-01' }));
  assert.equal(url.origin + url.pathname, 'https://api.semanticscholar.org/graph/v1/paper/search/bulk');
  assert.equal(url.searchParams.get('query'), 'quantum dot light-emitting diode');
  assert.equal(url.searchParams.get('publicationTypes'), 'JournalArticle');
  assert.equal(url.searchParams.get('sort'), 'publicationDate:desc');
  assert.equal(url.searchParams.get('publicationDateOrYear'), '2026-08-01:');
  assert.match(url.searchParams.get('fields'), /externalIds/);
  assert.equal(url.searchParams.get('token'), null);
});

test('buildBulkSearchUrl 翻页时带上 token', () => {
  const url = new URL(buildBulkSearchUrl({ query: 'q', since: '2026-08-01', token: 'abc123' }));
  assert.equal(url.searchParams.get('token'), 'abc123');
});

test('mapS2Paper：没有 DOI 的记录直接丢弃', () => {
  assert.equal(mapS2Paper({ title: 'x', externalIds: {} }), null);
  assert.equal(mapS2Paper(null), null);
});

test('mapS2Paper：映射字段、清理 JATS 标记、标记来源', () => {
  const mapped = mapS2Paper({
    paperId: 's2-1',
    title: 'Quantum Dot LEDs',
    abstract: '<jats:p>We report a QD-LED.</jats:p>',
    externalIds: { DOI: '10.1002/adma.202500001' },
    journal: { name: 'Advanced Materials', publisher: 'Wiley' },
    publicationTypes: ['JournalArticle'],
    publicationDate: '2026-08-05',
    citationCount: 7,
    openAccessPdf: { url: 'https://example.org/a.pdf' },
  });

  assert.equal(mapped.doi, '10.1002/adma.202500001');
  assert.equal(mapped.doi_url, 'https://doi.org/10.1002/adma.202500001');
  assert.equal(mapped.venue, 'Advanced Materials');
  assert.equal(mapped.publisher, 'Wiley');
  assert.equal(mapped.source_type, 'journal');
  assert.equal(mapped.pub_date, '2026-08-05');
  assert.equal(mapped.pub_year, 2026);
  assert.equal(mapped.abstract, 'We report a QD-LED.');
  assert.equal(mapped.abstract_source, 'semanticscholar');
  assert.deepEqual(mapped.sources, ['semanticscholar']);
  assert.deepEqual(mapped.publication_types, ['JournalArticle']);
  assert.equal(mapped.cited_by_count, 7);
  assert.equal(mapped.pdf_url, 'https://example.org/a.pdf');
  // 见刊判定交给闸门，适配器不预设结论
  assert.equal('published' in mapped, false);
});

test('s2Headers 只有配了 key 才带 x-api-key', () => {
  const original = process.env.SEMANTIC_SCHOLAR_API_KEY;
  try {
    delete process.env.SEMANTIC_SCHOLAR_API_KEY;
    assert.equal('x-api-key' in s2Headers(), false);
    process.env.SEMANTIC_SCHOLAR_API_KEY = 'test-key';
    assert.equal(s2Headers()['x-api-key'], 'test-key');
  } finally {
    if (original === undefined) delete process.env.SEMANTIC_SCHOLAR_API_KEY;
    else process.env.SEMANTIC_SCHOLAR_API_KEY = original;
  }
});

test('s2LookupBatch 空数组不发请求', async () => {
  const originalFetch = globalThis.fetch;
  let called = 0;
  globalThis.fetch = async () => {
    called += 1;
    return { ok: true, status: 200, json: async () => [], text: async () => '[]' };
  };
  try {
    assert.deepEqual(await s2LookupBatch([]), []);
    assert.equal(called, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('s2LookupBatch 按 S2_BATCH_SIZE 分块，返回数组与入参严格同序', async () => {
  const originalFetch = globalThis.fetch;
  const chunks = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body));
    chunks.push(body.ids);
    // 第一块返回「首尾有值、中间为 null」，第二块返回一个值：用来验证下标对齐
    const payload =
      body.ids.length === S2_BATCH_SIZE
        ? body.ids.map((_, i) => (i === 0 ? { paperId: 'first' } : i === S2_BATCH_SIZE - 1 ? { paperId: 'last-of-first' } : null))
        : [{ paperId: 'second-chunk' }];
    return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) };
  };

  try {
    const ids = Array.from({ length: S2_BATCH_SIZE + 1 }, (_, i) => `ARXIV:${i}`);
    const out = await s2LookupBatch(ids);

    assert.equal(chunks.length, 2);
    assert.equal(chunks[0].length, S2_BATCH_SIZE);
    assert.equal(chunks[1].length, 1);
    assert.equal(out.length, ids.length);
    assert.equal(out[0].paperId, 'first');
    assert.equal(out[1], null);
    assert.equal(out[S2_BATCH_SIZE - 1].paperId, 'last-of-first');
    assert.equal(out[S2_BATCH_SIZE].paperId, 'second-chunk');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
