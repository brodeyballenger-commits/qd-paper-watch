// src/semanticscholar.mjs
// Semantic Scholar 承担两个职责：
//   1. /paper/search/bulk —— 检索「已见刊期刊论文」（publicationTypes=JournalArticle），
//      天然带期刊名与 DOI，是本站第二重要的发现源；
//   2. /paper/batch —— 把 arXiv ID 批量换成期刊版本（这是「arXiv 只用于发现」的关键）。
// 实测：单篇 DOI 直查对新论文会 404（尚未收录），所以只用 bulk + batch，不要用 DOI 直查。

import { MAX_SOURCE_PAGES, S2_BATCH_SIZE, S2_DELAY_MS, SOURCE_PAGE_ROWS, SOURCE_QUERIES } from './config.mjs';
import { fetchWithRetry } from './http.mjs';
import { doiUrl, normalizeDoi, sleep, stripMarkup } from './util.mjs';

const BASE = 'https://api.semanticscholar.org/graph/v1';

/** bulk 检索要的字段（字段越少越省流量；abstract 用来喂 LLM） */
export const S2_BULK_FIELDS = [
  'title',
  'abstract',
  'venue',
  'journal',
  'externalIds',
  'publicationTypes',
  'publicationDate',
  'citationCount',
  'openAccessPdf',
].join(',');

/** batch 解析 arXiv ID 要的字段 */
export const S2_BATCH_FIELDS = [
  'title',
  'abstract',
  'venue',
  'journal',
  'externalIds',
  'publicationTypes',
  'publicationDate',
  'citationCount',
  'openAccessPdf',
].join(',');

export function s2Headers() {
  const key = process.env.SEMANTIC_SCHOLAR_API_KEY;
  return key ? { 'x-api-key': key } : {};
}

let lastCall = 0;

/** 未带 key 时 S2 是共享限流，自己至少间隔 S2_DELAY_MS */
async function throttle() {
  const wait = S2_DELAY_MS - (Date.now() - lastCall);
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();
}

export function buildBulkSearchUrl({ query, since, token = null }) {
  const params = new URLSearchParams({
    query,
    publicationTypes: 'JournalArticle',
    sort: 'publicationDate:desc',
    fields: S2_BULK_FIELDS,
  });
  if (since) params.set('publicationDateOrYear', `${since}:`);
  if (token) params.set('token', token);
  return `${BASE}/paper/search/bulk?${params.toString()}`;
}

/** S2 论文对象 -> 与 openalex.mapWork 同形的候选记录 */
export function mapS2Paper(p) {
  const doi = normalizeDoi(p?.externalIds?.DOI);
  if (!doi) return null; // 没有 DOI 的记录对我们没有意义

  const date = p?.publicationDate ?? null;
  const abstract = stripMarkup(p?.abstract || '') || null;
  const venue = p?.journal?.name ?? p?.venue ?? null;

  return {
    doi,
    doi_url: doiUrl(doi),
    title: stripMarkup(p?.title || ''),
    authors: [],
    venue: venue || null,
    issn_l: null,
    publisher: p?.journal?.publisher ?? null,
    source_type: 'journal',
    pub_date: date,
    pub_year: date ? Number(String(date).slice(0, 4)) || null : null,
    oa_status: p?.openAccessPdf?.url ? 'oa' : null,
    pdf_url: p?.openAccessPdf?.url ?? null,
    cited_by_count: p?.citationCount ?? 0,
    language: null,
    abstract,
    abstract_source: abstract ? 'semanticscholar' : null,
    sources: ['semanticscholar'],
    publication_types: Array.isArray(p?.publicationTypes) ? p.publicationTypes : [],
    type: 'article',
    s2_id: p?.paperId ?? null,
    openalex_id: null,
  };
}

/**
 * 期刊论文检索（多关键词 + token 翻页，最多 MAX_SOURCE_PAGES 页/词）。
 * @returns {Promise<{works: object[], total: number}>}
 */
export async function fetchS2Bulk({ since, log = console.log, queries = SOURCE_QUERIES } = {}) {
  const works = [];
  let total = null;

  for (const query of queries) {
    let token = null;
    let page = 0;

    while (page < MAX_SOURCE_PAGES) {
      await throttle();
      const url = buildBulkSearchUrl({ query, since, token });
      const data = await fetchWithRetry(url, {
        headers: s2Headers(),
        label: `Semantic Scholar bulk「${query}」第 ${page + 1} 页`,
      });

      if (total === null) {
        total = data?.total ?? 0;
        log(`   Semantic Scholar 报告命中 ${total} 条（关键词「${query}」）`);
      }

      const list = Array.isArray(data?.data) ? data.data : [];
      for (const item of list) {
        const mapped = mapS2Paper(item);
        if (mapped) works.push(mapped);
      }

      token = data?.token ?? null;
      page += 1;
      if (!token || list.length === 0) break;
    }
  }

  return { works, total: total ?? works.length };
}

/**
 * 批量把一批 S2 id（形如 ARXIV:2401.00001、DOI:10.xxxx/yyy）解析成论文对象。
 * 返回数组与入参**严格同序**，未收录的位置是 null。
 *
 * @param {string[]} ids
 * @param {object} [opts] { fields }
 */
export async function s2LookupBatch(ids, { fields = S2_BATCH_FIELDS } = {}) {
  const list = Array.isArray(ids) ? ids : [];
  const out = new Array(list.length).fill(null);
  if (list.length === 0) return out;

  for (let start = 0; start < list.length; start += S2_BATCH_SIZE) {
    const chunk = list.slice(start, start + S2_BATCH_SIZE);
    await throttle();

    const url = `${BASE}/paper/batch?fields=${encodeURIComponent(fields)}`;
    const data = await fetchWithRetry(url, {
      method: 'POST',
      body: { ids: chunk },
      headers: s2Headers(),
      label: `Semantic Scholar batch（${chunk.length} 个 id）`,
    });

    const arr = Array.isArray(data) ? data : [];
    for (let i = 0; i < chunk.length; i += 1) {
      out[start + i] = arr[i] ?? null;
    }
  }

  return out;
}
