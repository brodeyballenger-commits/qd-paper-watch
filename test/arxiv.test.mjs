import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArxivFeed, buildArxivUrl, fetchArxivEntries, resolveArxivEntries } from '../src/arxiv.mjs';

/** 一份最小的 arXiv Atom feed（两条：一条只有 journal_ref，一条带 <arxiv:doi>） */
const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
  <title>ArXiv Query</title>
  <entry>
    <id>http://arxiv.org/abs/2501.00001v1</id>
    <updated>2026-08-02T00:00:00Z</updated>
    <published>2026-07-30T00:00:00Z</published>
    <title>Quantum Dot LEDs with Record External Quantum Efficiency</title>
    <summary>We report a QD-LED with EQE above 30%.</summary>
    <author><name>Alice A</name></author>
    <author><name>Bob B</name></author>
    <arxiv:primary_category term="cond-mat.mtrl-sci"/>
    <arxiv:comment>Accepted by Advanced Materials</arxiv:comment>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/2501.00002v2</id>
    <published>2026-07-11T00:00:00Z</published>
    <title>Second Preprint About Nanocrystals</title>
    <summary>Abstract two.</summary>
    <author><name>Carol C</name></author>
    <arxiv:doi>10.1002/adts.202500570</arxiv:doi>
    <arxiv:journal_ref>Advanced Theory and Simulations</arxiv:journal_ref>
  </entry>
</feed>`;

test('parseArxivFeed 解析条目字段（id / 标题 / 作者 / 日期 / doi / journal_ref）', () => {
  const entries = parseArxivFeed(FEED);
  assert.equal(entries.length, 2);

  assert.equal(entries[0].arxivId, '2501.00001'); // 去掉 v1 后缀
  assert.equal(entries[0].title, 'Quantum Dot LEDs with Record External Quantum Efficiency');
  assert.deepEqual(entries[0].authors, ['Alice A', 'Bob B']);
  assert.equal(entries[0].pub_date, '2026-07-30');
  assert.equal(entries[0].category, 'cond-mat.mtrl-sci');
  assert.equal(entries[0].arxivDoi, null); // 没有 <arxiv:doi>
  assert.equal(entries[0].journalRef, null);
  assert.equal(entries[0].comment, 'Accepted by Advanced Materials');

  assert.equal(entries[1].arxivDoi, '10.1002/adts.202500570');
  assert.equal(entries[1].journalRef, 'Advanced Theory and Simulations');
});

test('parseArxivFeed 对空输入 / 无 entry 的 feed 返回空数组', () => {
  assert.deepEqual(parseArxivFeed(''), []);
  assert.deepEqual(parseArxivFeed(null), []);
  assert.deepEqual(parseArxivFeed('<feed><title>no entries</title></feed>'), []);
});

test('buildArxivUrl 同时带关键词与分类过滤，并按投稿时间倒序', () => {
  const url = buildArxivUrl({ query: 'quantum dot light-emitting diode', categories: ['cond-mat.mtrl-sci'], maxResults: 5 });
  const parsed = new URL(url);
  assert.equal(parsed.origin + parsed.pathname, 'https://export.arxiv.org/api/query');
  const q = parsed.searchParams.get('search_query');
  assert.match(q, /all:"quantum dot light-emitting diode"/);
  assert.match(q, /cat:cond-mat\.mtrl-sci/);
  assert.match(q, /AND/);
  assert.equal(parsed.searchParams.get('sortBy'), 'submittedDate');
  assert.equal(parsed.searchParams.get('sortOrder'), 'descending');
  assert.equal(parsed.searchParams.get('max_results'), '5');
});

test('fetchArxivEntries 按时间窗口过滤：窗口外的老预印本不能混进「最新论文」', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => FEED, // 两条：2026-07-30 与 2026-07-11
    json: async () => ({}),
  });

  try {
    const logs = [];
    const kept = await fetchArxivEntries({ log: (m) => logs.push(m), queries: ['demo'], since: '2026-07-20', delayMs: 0 });
    assert.deepEqual(kept.map((e) => e.arxivId), ['2501.00001']); // 07-11 那条被挡掉
    assert.match(logs.join('\n'), /窗口内（2026-07-20 起）1 条/);

    // 无窗口时两条都保留（老行为，供测试与手工调试使用）
    const all = await fetchArxivEntries({ log: () => {}, queries: ['demo'], delayMs: 0 });
    assert.equal(all.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('resolveArxivEntries：解析出期刊版本的保留，解析不出的丢弃', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: init?.body });
    // 第 1 条：S2 里没有（null）；第 2 条：S2 给出期刊版 DOI；后两条用 <arxiv:doi> / 都没有
    const payload = [
      null,
      {
        paperId: 's2-2',
        externalIds: { DOI: '10.1002/adma.202500123' },
        journal: { name: 'Advanced Materials', publisher: 'Wiley' },
        publicationDate: '2026-08-05',
        publicationTypes: ['JournalArticle'],
        citationCount: 3,
        title: 'Second Preprint About Nanocrystals',
      },
      null,
      null,
    ];
    return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) };
  };

  try {
    const entries = [
      { arxivId: '2501.00001', title: 'First', authors: ['A'], pub_date: '2026-07-30', abstract: 'a1', arxivDoi: null, journalRef: null },
      { arxivId: '2501.00002', title: 'Second Preprint About Nanocrystals', authors: ['C'], pub_date: '2026-07-11', abstract: 'a2', arxivDoi: null, journalRef: null },
      { arxivId: '2501.00003', title: 'Third', authors: ['D'], pub_date: '2026-07-01', abstract: 'a3', arxivDoi: '10.1002/adts.202500570', journalRef: 'Advanced Theory and Simulations' },
      { arxivId: '2501.00004', title: 'Fourth', authors: ['E'], pub_date: '2026-06-01', abstract: 'a4', arxivDoi: null, journalRef: null },
    ];

    const { works, dropped } = await resolveArxivEntries(entries, { log: () => {} });

    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/paper\/batch\?fields=/);
    assert.match(String(calls[0].body), /ARXIV:2501\.00001/);

    // 第 1 条只有 arXiv 自己给的 DOI（这里没有）→ 丢弃；第 2 条走 S2；第 3 条走 <arxiv:doi>；第 4 条丢弃
    assert.equal(works.length, 2);
    assert.equal(dropped, 2);

    const fromS2 = works[0];
    assert.equal(fromS2.doi, '10.1002/adma.202500123');
    assert.equal(fromS2.venue, 'Advanced Materials');
    assert.equal(fromS2.published, true);
    assert.equal(fromS2.published_source, 'semanticscholar');
    assert.deepEqual(fromS2.sources, ['arxiv', 'semanticscholar']);
    assert.equal(fromS2.arxiv_id, '2501.00002');
    assert.equal(fromS2.pdf_url, 'https://arxiv.org/pdf/2501.00002'); // 没有 OA PDF 时回退 arXiv

    const fromArxivDoi = works[1];
    assert.equal(fromArxivDoi.doi, '10.1002/adts.202500570');
    assert.equal(fromArxivDoi.venue, 'Advanced Theory and Simulations');
    assert.equal(fromArxivDoi.published_source, 'arxiv-doi');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
