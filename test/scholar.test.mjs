import test from 'node:test';
import assert from 'node:assert/strict';
import {
  scholarEnabled,
  buildScholarUrl,
  parseScholarResults,
  titleSimilarity,
  resolveScholarEntry,
  fetchScholarPublished,
} from '../src/scholar.mjs';

function withKey(value, fn) {
  const original = process.env.SERPAPI_KEY;
  if (value === undefined) delete process.env.SERPAPI_KEY;
  else process.env.SERPAPI_KEY = value;
  try {
    return fn();
  } finally {
    if (original === undefined) delete process.env.SERPAPI_KEY;
    else process.env.SERPAPI_KEY = original;
  }
}

test('scholarEnabled 只有配了 SERPAPI_KEY 才为真（可选源）', () => {
  withKey(undefined, () => assert.equal(scholarEnabled(), false));
  withKey('', () => assert.equal(scholarEnabled(), false));
  withKey('test-key', () => assert.equal(scholarEnabled(), true));
});

test('buildScholarUrl 走 SerpApi 的 google_scholar 引擎', () => {
  const url = new URL(buildScholarUrl({ query: 'quantum dot LED', apiKey: 'k1', num: 20 }));
  assert.equal(url.origin + url.pathname, 'https://serpapi.com/search.json');
  assert.equal(url.searchParams.get('engine'), 'google_scholar');
  assert.equal(url.searchParams.get('q'), 'quantum dot LED');
  assert.equal(url.searchParams.get('api_key'), 'k1');
  assert.equal(url.searchParams.get('num'), '20');
});

test('parseScholarResults：取标题/摘要/年份/作者，丢弃没有标题的条目', () => {
  const parsed = parseScholarResults({
    organic_results: [
      {
        title: 'Quantum Dot LEDs with Record EQE',
        snippet: 'We report …',
        link: 'https://example.org/x',
        publication_info: { summary: 'A. Alpha, B. Beta - Advanced Materials, 2026', authors: [{ name: 'A. Alpha' }, { name: 'B. Beta' }] },
      },
      { snippet: 'no title here' },
    ],
  });

  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].title, 'Quantum Dot LEDs with Record EQE');
  assert.equal(parsed[0].snippet, 'We report …');
  assert.equal(parsed[0].summary, 'A. Alpha, B. Beta - Advanced Materials, 2026');
  assert.deepEqual(parsed[0].authors, ['A. Alpha', 'B. Beta']);
  assert.deepEqual(parseScholarResults(null), []);
});

test('titleSimilarity 用词集合交并比：同标题=1，Unicode 连字符差异仍然很高，不相关则很低', () => {
  assert.equal(titleSimilarity('Quantum Dot LEDs', 'Quantum Dot LEDs'), 1);
  // 期刊标题里常见 U+2010 连字符，归一化后应几乎完全一致
  assert.ok(titleSimilarity('Deep‐Blue Quantum‐Dot LEDs', 'Deep-Blue Quantum-Dot LEDs') >= 0.9);
  const unrelated = titleSimilarity('Quantum Dot LEDs with Record EQE', 'Perovskite Solar Cells Passivation');
  assert.ok(unrelated < 0.7, `不相关标题的相似度应该低于阈值，实际 ${unrelated}`);
  assert.equal(titleSimilarity('', 'anything'), 0);
});

test('resolveScholarEntry：在 Crossref 里按标题找到期刊论文才算「已见刊」，找不到返回 null', async () => {
  const originalFetch = globalThis.fetch;
  const title = 'Quantum Dot LEDs with Record External Quantum Efficiency';

  globalThis.fetch = async () => {
    const payload = {
      message: {
        items: [
          {
            DOI: '10.1002/adma.202500001',
            title: [title],
            'container-title': ['Advanced Materials'],
            type: 'journal-article',
            published: { 'date-parts': [[2026, 8, 5]] },
          },
          {
            DOI: '10.1002/unrelated',
            title: ['Perovskite Solar Cells Passivation'],
            'container-title': ['Solar RRL'],
            type: 'journal-article',
          },
        ],
      },
    };
    return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) };
  };

  try {
    const resolved = await resolveScholarEntry({ title, authors: ['A. Alpha'] });
    assert.equal(resolved.doi, '10.1002/adma.202500001');
    assert.equal(resolved.venue, 'Advanced Materials');
    assert.equal(resolved.published, true);
    assert.equal(resolved.published_source, 'crossref');
    assert.deepEqual([...resolved.sources].sort(), ['crossref', 'scholar']);

    const missed = await resolveScholarEntry({ title: 'A Title That Crossref Does Not Have At All' });
    assert.equal(missed, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchScholarPublished：没有 key 时静默返回空，且不发任何请求', async () => {
  const originalFetch = globalThis.fetch;
  let called = 0;
  globalThis.fetch = async () => {
    called += 1;
    return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' };
  };
  try {
    const result = await withKey(undefined, () => fetchScholarPublished({ log: () => {}, queries: ['x'] }));
    assert.deepEqual(result, { works: [], total: 0, dropped: 0 });
    assert.equal(called, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
