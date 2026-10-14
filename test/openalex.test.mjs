import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWorksUrl } from '../src/openalex.mjs';

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
