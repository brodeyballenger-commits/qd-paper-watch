import test from 'node:test';
import assert from 'node:assert/strict';
import {
  backfillAbstracts,
  buildOpenAlexDoiFilterUrl,
  collectMissingAbstract,
} from '../src/abstract-backfill.mjs';

const LONG = 'A'.repeat(80);

test('collectMissingAbstract：只收缺摘要的 DOI，按 DOI 去重、缺 DOI 的跳过', () => {
  const raws = [
    { doi: '10.1000/aaa', abstract: null },
    { doi: '10.1000/BBB', abstract: '' },
    { doi: '10.1000/bbb', abstract: '  ' }, // 同一个 DOI（大小写不同）只算一次
    { doi: '10.1000/ccc', abstract: LONG }, // 已经有摘要
    { doi: '10.1000/ddd', abstract: '太短了' }, // 短摘要视为没有
    { doi: null, abstract: null }, // 没 DOI 没法补
    { doi: '10.1000/eee' },
    {}, // 空对象
  ];
  assert.deepEqual(collectMissingAbstract(raws), ['10.1000/aaa', '10.1000/bbb', '10.1000/ddd', '10.1000/eee']);
});

test('collectMissingAbstract：空输入安全', () => {
  assert.deepEqual(collectMissingAbstract([]), []);
  assert.deepEqual(collectMissingAbstract(null), []);
  assert.deepEqual(collectMissingAbstract(undefined), []);
});

test('buildOpenAlexDoiFilterUrl：竖线连接、per-page=50、select 只取需要的字段', () => {
  const url = buildOpenAlexDoiFilterUrl(['10.1000/aaa', '10.1000/bbb']);
  assert.match(url, /^https:\/\/api\.openalex\.org\/works\?/);
  assert.match(url, /filter=doi%3A10\.1000%2Faaa%7C10\.1000%2Fbbb/);
  assert.match(url, /select=doi%2Cabstract_inverted_index/);
  assert.match(url, /per-page=50/);
});

test('buildOpenAlexDoiFilterUrl：填了 OPENALEX_API_KEY 就带上 api_key', () => {
  const saved = process.env.OPENALEX_API_KEY;
  process.env.OPENALEX_API_KEY = 'oa-test-key';
  try {
    assert.match(buildOpenAlexDoiFilterUrl(['10.1000/aaa']), /api_key=oa-test-key/);
  } finally {
    if (saved === undefined) delete process.env.OPENALEX_API_KEY;
    else process.env.OPENALEX_API_KEY = saved;
  }
});

test('buildOpenAlexDoiFilterUrl：没填 key 时不出现 api_key', () => {
  const saved = process.env.OPENALEX_API_KEY;
  delete process.env.OPENALEX_API_KEY;
  try {
    assert.doesNotMatch(buildOpenAlexDoiFilterUrl(['10.1000/aaa']), /api_key=/);
  } finally {
    if (saved !== undefined) process.env.OPENALEX_API_KEY = saved;
  }
});

test('backfillAbstracts：Semantic Scholar 补到的写 semanticscholar', async () => {
  const raws = [
    { doi: '10.1000/aaa', abstract: null },
    { doi: '10.1000/bbb', abstract: null },
  ];
  const calls = [];
  const stats = await backfillAbstracts(raws, {
    log: () => {},
    s2Lookup: async (ids, opts) => {
      calls.push({ ids, opts });
      return [{ abstract: LONG }, null];
    },
    fetchJson: async () => {
      throw new Error('不该走到 OpenAlex');
    },
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].ids, ['DOI:10.1000/aaa', 'DOI:10.1000/bbb']);
  assert.equal(calls[0].opts.fields, 'title,abstract');
  assert.equal(raws[0].abstract, LONG);
  assert.equal(raws[0].abstract_source, 'semanticscholar');
  assert.equal(raws[1].abstract, null);
  assert.equal(raws[1].abstract_source, undefined);
  assert.deepEqual(stats, { missing: 2, filled: 1, semanticscholar: 1, openalex: 0, stillMissing: 1 });
});

test('backfillAbstracts：S2 没给的交由 OpenAlex 倒排索引还原', async () => {
  const raws = [{ doi: '10.1000/aaa', abstract: null }];
  const urls = [];
  const words = 'Quantum dot light emitting diodes achieve record external quantum efficiency and long lifetime'.split(' ');
  const stats = await backfillAbstracts(raws, {
    log: () => {},
    s2Lookup: async () => [null],
    fetchJson: async (url) => {
      urls.push(url);
      return {
        results: [
          {
            doi: 'https://doi.org/10.1000/aaa',
            abstract_inverted_index: Object.fromEntries(words.map((w, i) => [w, [i]])),
          },
        ],
      };
    },
  });

  assert.equal(urls.length, 1);
  assert.match(urls[0], /filter=doi%3A10\.1000%2Faaa/);
  assert.equal(raws[0].abstract, words.join(' '));
  assert.equal(raws[0].abstract_source, 'openalex');
  assert.deepEqual(stats, { missing: 1, filled: 1, semanticscholar: 0, openalex: 1, stillMissing: 0 });
});

test('backfillAbstracts：两个接口都失败也不抛错，保持缺失', async () => {
  const raws = [{ doi: '10.1000/aaa', abstract: null }];
  const stats = await backfillAbstracts(raws, {
    log: () => {},
    s2Lookup: async () => {
      throw new Error('S2 挂了');
    },
    fetchJson: async () => {
      throw new Error('OpenAlex 也挂了');
    },
  });

  assert.equal(raws[0].abstract, null);
  assert.equal(stats.filled, 0);
  assert.equal(stats.stillMissing, 1);
});

test('backfillAbstracts：没有缺摘要的论文时不发任何请求', async () => {
  const raws = [{ doi: '10.1000/aaa', abstract: LONG }];
  let called = 0;
  const stats = await backfillAbstracts(raws, {
    log: () => {},
    s2Lookup: async () => {
      called += 1;
      return [];
    },
    fetchJson: async () => {
      called += 1;
      return {};
    },
  });

  assert.equal(called, 0);
  assert.deepEqual(stats, { missing: 0, filled: 0, semanticscholar: 0, openalex: 0, stillMissing: 0 });
});

test('backfillAbstracts：同标题多条记录共享同一个 DOI 时一起补上', async () => {
  const raws = [
    { doi: '10.1000/aaa', abstract: null, title: 'One' },
    { doi: '10.1000/AAA', abstract: null, title: 'One duplicate' },
  ];
  await backfillAbstracts(raws, {
    log: () => {},
    s2Lookup: async () => [{ abstract: LONG }],
    fetchJson: async () => ({}),
  });

  assert.equal(raws[0].abstract, LONG);
  assert.equal(raws[1].abstract, LONG);
  assert.equal(raws[1].abstract_source, 'semanticscholar');
});
