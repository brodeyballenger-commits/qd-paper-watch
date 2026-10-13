// src/scholar.mjs
// Google 学术（经 SerpApi）—— **可选源**，只有配置了 SERPAPI_KEY 才启用。
//
// 为什么必须走 SerpApi：Google 学术没有公开 API，而且明确禁止抓取
// （实测直接抓 `scholar.google.com/scholar?q=…` 虽然返回 200，但那是违反其条款的做法）。
// 参照仓库 dww911/Paper-Tracker 也是用 SerpApi 的 `engine=google_scholar`。
//
// 为什么它的结果要再经 Crossref：Google 学术给的是标题 + 摘要片段，没有可靠的 DOI，
// 而本站在「已见刊」上是硬门槛 —— 只有能在 Crossref 找到期刊论文（journal-article）
// 且标题高度一致的条目才收。

import { SOURCE_QUERIES } from './config.mjs';
import { fetchCrossrefByTitle } from './crossref-works.mjs';
import { fetchWithRetry } from './http.mjs';
import { normalizeText, sleep } from './util.mjs';

const ENDPOINT = 'https://serpapi.com/search.json';
const MAX_RESULTS = 20;
/** 每次构建最多为多少条学术结果去 Crossref 换 DOI（Crossref 要求 1 req/s，别贪） */
const MAX_RESOLVE = 20;

export function scholarEnabled() {
  return Boolean(process.env.SERPAPI_KEY);
}

export function buildScholarUrl({ query, apiKey, num = MAX_RESULTS }) {
  const params = new URLSearchParams({
    engine: 'google_scholar',
    q: query,
    num: String(num),
    hl: 'zh-CN',
  });
  if (apiKey) params.set('api_key', apiKey);
  return `${ENDPOINT}?${params.toString()}`;
}

/**
 * SerpApi 响应 -> 学术条目（纯函数）。
 * 只取我们真正用得上的字段；`publication_info.summary` 里往往写着期刊名与年份，
 * 但那只是字符串，不能当作「已见刊」的证据。
 */
export function parseScholarResults(json) {
  const results = Array.isArray(json?.organic_results) ? json.organic_results : [];
  return results
    .map((r) => ({
      title: normalizeText(String(r?.title ?? '')).trim(),
      snippet: String(r?.snippet ?? '').trim() || null,
      link: r?.link ?? null,
      summary: String(r?.publication_info?.summary ?? '').trim() || null,
      authors: (Array.isArray(r?.publication_info?.authors) ? r.publication_info.authors : [])
        .map((a) => String(a?.name ?? '').trim())
        .filter(Boolean)
        .slice(0, 3),
    }))
    .filter((r) => r.title);
}

/** 标题归一化成词集合（去标点、去大小写、去 Unicode 连字符） */
function titleTokens(title) {
  return new Set(
    normalizeText(String(title ?? ''))
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ')
      .split(' ')
      .filter((t) => t.length > 1),
  );
}

/**
 * 标题相似度（Jaccard 词集合交并比）。
 * 为什么不用编辑距离：期刊标题与 arXiv/学术口径常常只差一两个连字符或副标题，
 * 词集合交并比更稳，而且阈值好解释（≥0.7 视为同一篇）。
 */
export function titleSimilarity(a, b) {
  const sa = titleTokens(a);
  const sb = titleTokens(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter += 1;
  return inter / (sa.size + sb.size - inter);
}

/**
 * 把一条学术结果解析成「已见刊」候选：在 Crossref 里按标题找期刊论文，
 * 选相似度最高的一条（阈值 0.7），拿到 DOI + 期刊名。
 *
 * @returns {Promise<object|null>}
 */
export async function resolveScholarEntry(entry, { minSimilarity = 0.7 } = {}) {
  if (!entry?.title) return null;

  const candidates = await fetchCrossrefByTitle(entry.title, { rows: 3 });
  let best = null;
  let bestScore = 0;

  for (const c of candidates) {
    const score = titleSimilarity(entry.title, c.title);
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }

  if (!best || bestScore < minSimilarity) return null;

  return {
    ...best,
    // 来源数组要同时记住「学术发现 + Crossref 定见刊」
    sources: [...new Set([...(best.sources ?? []), 'scholar'])],
    published: true,
    published_source: 'crossref',
    // 学术结果里可能有更多作者信息，Crossref 没有就补上
    authors: best.authors?.length ? best.authors : entry.authors,
    abstract: best.abstract ?? null,
  };
}

/**
 * 抓取 + 解析。没有 key 时直接返回空数组（静默跳过）。
 * @returns {Promise<{works: object[], total: number, dropped: number}>}
 */
export async function fetchScholarPublished({ log = console.log, queries = SOURCE_QUERIES } = {}) {
  const apiKey = process.env.SERPAPI_KEY;
  if (!apiKey) {
    log('   Google 学术：未配置 SERPAPI_KEY，跳过（可选源）');
    return { works: [], total: 0, dropped: 0 };
  }

  const entries = [];
  for (const query of queries) {
    const data = await fetchWithRetry(buildScholarUrl({ query, apiKey }), {
      label: `Google 学术（SerpApi）「${query}」`,
    });
    const list = parseScholarResults(data);
    entries.push(...list);
    log(`   Google 学术「${query}」：${list.length} 条`);
    await sleep(1200);
  }

  const works = [];
  let dropped = 0;
  const seen = new Set();

  for (const entry of entries.slice(0, MAX_RESOLVE)) {
    const key = entry.title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const resolved = await resolveScholarEntry(entry);
    if (resolved) works.push(resolved);
    else dropped += 1;
    await sleep(400);
  }

  log(`   Google 学术：解析出期刊版本 ${works.length} 条，丢弃 ${dropped} 条（Crossref 里找不到期刊论文）`);
  return { works, total: entries.length, dropped };
}
