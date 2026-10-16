import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWorksUrl, fetchWorks, sliceWindows } from '../src/openalex.mjs';

/** 临时改环境变量，跑完恢复（测试之间不串味） */
function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === null) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('buildWorksUrl：主题 + 日期窗口 + 只要 article + 默认游标', () => {
  withEnv({ OPENALEX_API_KEY: null, CONTACT_EMAIL: null }, () => {
    const url = new URL(buildWorksUrl({ fromDate: '2026-09-30', toDate: '2026-10-14' }));
    assert.equal(`${url.origin}${url.pathname}`, 'https://api.openalex.org/works');

    const filter = url.searchParams.get('filter');
    assert.match(filter, /^primary_topic\.id:/);
    assert.match(filter, /from_publication_date:2026-09-30/);
    assert.match(filter, /to_publication_date:2026-10-14/);
    assert.match(filter, /type:article/);
    assert.match(filter, /is_retracted:false/);

    assert.equal(url.searchParams.get('cursor'), '*');
    assert.equal(url.searchParams.get('sort'), 'publication_date:desc');
    assert.equal(url.searchParams.get('mailto'), null);
    assert.equal(url.searchParams.get('api_key'), null);
  });
});

test('buildWorksUrl：填了 OPENALEX_API_KEY / CONTACT_EMAIL 就带上', () => {
  withEnv({ OPENALEX_API_KEY: 'oa-test-key', CONTACT_EMAIL: 'me@example.com' }, () => {
    const url = new URL(buildWorksUrl({ fromDate: '2026-09-30' }));
    assert.equal(url.searchParams.get('api_key'), 'oa-test-key');
    assert.equal(url.searchParams.get('mailto'), 'me@example.com');
  });
});

test('buildWorksUrl：没有 toDate 时不写 to_publication_date，游标可覆盖', () => {
  withEnv({ OPENALEX_API_KEY: null, CONTACT_EMAIL: null }, () => {
    const url = new URL(buildWorksUrl({ fromDate: '2026-09-30', cursor: 'AoJxxxx' }));
    assert.doesNotMatch(url.searchParams.get('filter'), /to_publication_date/);
    assert.equal(url.searchParams.get('cursor'), 'AoJxxxx');
  });
});

test('sliceWindows：从最新往回切 7 天一片，首片贴住 toDate，末片贴住 fromDate', () => {
  const slices = sliceWindows('2026-09-30', '2026-10-14');
  assert.deepEqual(slices, [
    { from: '2026-10-08', to: '2026-10-14' },
    { from: '2026-10-01', to: '2026-10-07' },
    { from: '2026-09-30', to: '2026-09-30' },
  ]);
  // 片与片之间不重叠、不留空
  for (let i = 1; i < slices.length; i += 1) {
    const gap = Date.parse(`${slices[i - 1].from}T00:00:00Z`) - Date.parse(`${slices[i].to}T00:00:00Z`);
    assert.equal(gap, 86400000);
  }
});

test('sliceWindows：窗口不足一片时只有一片；参数不合法时返回空数组', () => {
  assert.deepEqual(sliceWindows('2026-10-10', '2026-10-14'), [{ from: '2026-10-10', to: '2026-10-14' }]);
  assert.deepEqual(sliceWindows(null, '2026-10-14'), []);
  assert.deepEqual(sliceWindows('2026-10-20', '2026-10-14'), []);
});

test('fetchWorks：没有 api_key 时翻页被拒 → 退回日期切片，已取回的第一页不丢', async () => {
  const originalFetch = globalThis.fetch;
  const urls = [];
  const work = (n) => ({
    id: `https://openalex.org/W${n}`,
    doi: `https://doi.org/10.1000/test.${n}`,
    title: `Paper ${n}`,
    publication_date: '2026-10-13',
    type: 'article',
    primary_location: { source: { display_name: 'J. Test', type: 'journal' } },
  });

  globalThis.fetch = async (url) => {
    const u = new URL(String(url));
    urls.push(u);
    // 所有 cursor=* 的请求都成功（第一页 + 日期切片）；只有真正的翻页请求会被拒
    if (u.searchParams.get('cursor') === '*') {
      const isFirst = urls.length === 1;
      const payload = {
        meta: { count: 2, next_cursor: isFirst ? 'CURSOR-2' : null },
        results: isFirst ? [work(1), work(2)] : [],
      };
      return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) };
    }
    // 第 2 页：无 key 时 OpenAlex 的真实回复
    return {
      ok: false,
      status: 401,
      text: async () => '{"error":"API key required for cursor paging"}',
    };
  };

  const savedKey = process.env.OPENALEX_API_KEY;
  delete process.env.OPENALEX_API_KEY;
  const logs = [];
  try {
    const result = await fetchWorks({ fromDate: '2026-09-30', toDate: '2026-10-14', log: (m) => logs.push(m) });
    assert.equal(result.works.length, 2, '第一页的结果必须保留');
    assert.equal(result.total, 2);
    assert.equal(result.partial, true);
    assert.match(logs.join('\n'), /不能 cursor 翻页|禁止 cursor 翻页/);
    assert.match(logs.join('\n'), /日期切片/);
    // 切片请求确实发生了，且都是从 cursor=* 开始（filter 里带的是切片的日期上界）
    const sliceUrls = urls.filter((u) => (u.searchParams.get('filter') ?? '').includes('to_publication_date:2026-10-07'));
    assert.equal(sliceUrls.length, 1, '应当用日期切片补抓');
    assert.equal(sliceUrls[0].searchParams.get('cursor'), '*');
  } finally {
    globalThis.fetch = originalFetch;
    if (savedKey === undefined) delete process.env.OPENALEX_API_KEY;
    else process.env.OPENALEX_API_KEY = savedKey;
  }
});

test('fetchWorks：翻了 3 页后第 4 页失败（不可重试）→ 保留前 3 页，不抛错', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls <= 3) {
      const payload = {
        meta: { count: 300, next_cursor: `C${calls}` },
        results: [{ id: `W${calls}`, doi: `https://doi.org/10.1000/p.${calls}`, title: `T${calls}` }],
      };
      return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) };
    }
    // 404 不可重试，立刻抛出（用 5xx 会触发退避重试，测试变慢）
    return { ok: false, status: 404, text: async () => 'not found' };
  };

  try {
    const result = await fetchWorks({ fromDate: '2026-09-30', log: () => {} });
    assert.equal(result.works.length, 3);
    assert.equal(result.partial, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
