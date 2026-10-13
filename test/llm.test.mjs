import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DIRECTION_IDS } from '../src/config.mjs';
import { applySummary, cacheKey, normalizeSummary, parseSummaryJson, summarizePapers } from '../src/llm.mjs';

const mkPaper = (over = {}) => ({
  doi: '10.1002/adma.202600001',
  title: 'Bright Quantum Dot Light-Emitting Diodes',
  abstract: 'We report quantum dot light-emitting diodes with 30% EQE.',
  abstract_hash: 'hash-a',
  directions: ['display'],
  innovation_zh: null,
  pending_summary: true,
  ...over,
});

const okResponse = (payload) => ({
  ok: true,
  status: 200,
  json: async () => ({ choices: [{ message: { content: JSON.stringify(payload) } }] }),
});

const VALID_SUMMARY = {
  title_zh: '高亮度量子点发光二极管',
  innovation_zh: '提出了新的界面钝化策略',
  method_zh: '热注入合成 + 原子层沉积封装',
  directions: ['display', 'materials'],
  novelty_score: 5,
  novelty_reason: '首次实现室温连续激射',
  keywords_zh: ['量子点', 'QLED'],
};

test('cacheKey 随提示词版本/DOI/摘要哈希变化', () => {
  const base = mkPaper();
  assert.equal(cacheKey(base), cacheKey(mkPaper()));
  assert.notEqual(cacheKey(base), cacheKey(mkPaper({ doi: '10.1/other' })));
  assert.notEqual(cacheKey(base), cacheKey(mkPaper({ abstract_hash: 'hash-b' })));
  assert.notEqual(cacheKey(base), cacheKey(mkPaper({ abstract_hash: null })));
});

test('parseSummaryJson 容忍代码块与前后缀文字', () => {
  assert.deepEqual(parseSummaryJson('{"a":1}'), { a: 1 });
  assert.deepEqual(parseSummaryJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseSummaryJson('```\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseSummaryJson('以下是结果：{"a":1} 希望有帮助'), { a: 1 });
});

test('parseSummaryJson 对垃圾输入返回 null', () => {
  assert.equal(parseSummaryJson(''), null);
  assert.equal(parseSummaryJson(null), null);
  assert.equal(parseSummaryJson('抱歉，我无法完成'), null);
  assert.equal(parseSummaryJson('{"broken":'), null);
});

test('normalizeSummary 过滤越界方向、夹住分数、限制关键词数量', () => {
  const out = normalizeSummary({
    title_zh: '  标题  ',
    innovation_zh: '创新',
    directions: ['display', 'not-a-direction', 'display', 'materials'],
    novelty_score: 9,
    keywords_zh: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'],
  });
  assert.equal(out.title_zh, '标题');
  assert.deepEqual(out.directions, ['display', 'materials']);
  assert.ok(out.directions.every((d) => DIRECTION_IDS.includes(d)));
  assert.equal(out.novelty_score, 5);
  assert.equal(out.keywords_zh.length, 8);

  assert.equal(normalizeSummary({ novelty_score: 0 }).novelty_score, 1);
  assert.equal(normalizeSummary({ novelty_score: 3.4 }).novelty_score, 3);
  assert.equal(normalizeSummary({ novelty_score: 'abc' }).novelty_score, null);
  assert.equal(normalizeSummary({ title_zh: '   ' }).title_zh, null);
});

test('normalizeSummary 对非对象返回 null', () => {
  assert.equal(normalizeSummary(null), null);
  assert.equal(normalizeSummary('text'), null);
});

test('applySummary 把结果写入论文并清掉待生成标记', () => {
  const paper = mkPaper();
  applySummary(paper, normalizeSummary(VALID_SUMMARY), 'deepseek-chat');
  assert.equal(paper.innovation_zh, '提出了新的界面钝化策略');
  assert.equal(paper.novelty_score, 5);
  assert.equal(paper.summary_source, 'llm');
  assert.equal(paper.pending_summary, false);
  assert.equal(paper.llm_model, 'deepseek-chat');
  assert.deepEqual(paper.directions, ['display', 'materials']);
});

test('applySummary 合并方向时去重，且永不为空', () => {
  const paper = mkPaper({ directions: [] });
  applySummary(paper, { ...normalizeSummary({ directions: ['quantuminfo'] }) }, 'deepseek-chat');
  assert.deepEqual(paper.directions, ['quantuminfo']);
});

test('没有 API key 时跳过，不改动任何论文（也不发请求）', async () => {
  const originalFetch = globalThis.fetch;
  let called = 0;
  globalThis.fetch = async () => { called += 1; return okResponse(VALID_SUMMARY); };
  try {
    const papers = [mkPaper()];
    const { stats, skippedReason } = await summarizePapers(papers, { apiKey: '', log: () => {} });
    assert.equal(skippedReason, 'no-api-key');
    assert.equal(stats.pending, 1);
    assert.equal(stats.generated, 0);
    assert.equal(called, 0);
    assert.equal(papers[0].innovation_zh, null);
    assert.equal(papers[0].pending_summary, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('命中缓存时直接套用结果，不发请求', async () => {
  const originalFetch = globalThis.fetch;
  let called = 0;
  globalThis.fetch = async () => { called += 1; return okResponse(VALID_SUMMARY); };
  try {
    const paper = mkPaper();
    const cache = { [cacheKey(paper)]: { at: '2026-10-01T00:00:00.000Z', model: 'deepseek-chat', summary: normalizeSummary(VALID_SUMMARY) } };
    const { stats } = await summarizePapers([paper], { apiKey: 'test-key', cache, log: () => {} });
    assert.equal(stats.fromCache, 1);
    assert.equal(stats.generated, 0);
    assert.equal(called, 0);
    assert.equal(paper.innovation_zh, '提出了新的界面钝化策略');
    assert.equal(paper.pending_summary, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('真实调用路径：请求体与鉴权头正确，结果写回论文并写入缓存', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts) => { calls.push({ url, opts }); return okResponse(VALID_SUMMARY); };
  try {
    const paper = mkPaper();
    const cache = {};
    const { stats, skippedReason } = await summarizePapers([paper], { apiKey: 'test-key', baseUrl: 'https://api.deepseek.com/', model: 'deepseek-chat', cache, log: () => {} });

    assert.equal(skippedReason, null);
    assert.equal(stats.generated, 1);
    assert.equal(stats.failed, 0);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.deepseek.com/chat/completions');
    assert.equal(calls[0].opts.headers.Authorization, 'Bearer test-key');
    const body = JSON.parse(calls[0].opts.body);
    assert.equal(body.model, 'deepseek-chat');
    assert.deepEqual(body.response_format, { type: 'json_object' });
    assert.match(body.messages[1].content, /Bright Quantum Dot Light-Emitting Diodes/);

    assert.equal(paper.innovation_zh, '提出了新的界面钝化策略');
    assert.equal(paper.pending_summary, false);
    assert.ok(cache[cacheKey(paper)]?.summary?.innovation_zh);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('单篇失败不影响整轮：标记 failed 并保持待生成，下一轮自动重试', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 401, text: async () => 'invalid api key' });
  try {
    const paper = mkPaper();
    const { stats } = await summarizePapers([paper], { apiKey: 'bad-key', log: () => {} });
    assert.equal(stats.failed, 1);
    assert.equal(stats.generated, 0);
    assert.equal(paper.pending_summary, true);
    assert.equal(paper.summary_source, 'failed');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('没有待生成的论文时不做任何事', async () => {
  const originalFetch = globalThis.fetch;
  let called = 0;
  globalThis.fetch = async () => { called += 1; return okResponse(VALID_SUMMARY); };
  try {
    const paper = mkPaper({ pending_summary: false, innovation_zh: '已有' });
    const { stats, skippedReason } = await summarizePapers([paper], { apiKey: 'test-key', log: () => {} });
    assert.equal(stats.pending, 0);
    assert.equal(skippedReason, null);
    assert.equal(called, 0);
    assert.equal(paper.innovation_zh, '已有');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
