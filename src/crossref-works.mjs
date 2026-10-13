// src/crossref-works.mjs
// Crossref 检索源：按标题相关度检索期刊论文（filter 固定 type:journal-article），
// 本身就是期刊论文登记库，天然满足「已见刊」，而且比 OpenAlex 更早看到正式版本。
// 摘要缺失的问题统一交给 src/abstract-backfill.mjs 用批量接口补，这里不逐篇查。
//
// 实测踩过的坑（改动前请先跑 npm test）：
//   1. select 里**不能**放 subtype，否则 HTTP 400（select-not-available）；
//   2. 只加 sort=published&order=desc 会把 2121-10-01 这种未来日期垃圾排在最前，
//      所以必须同时用 from-pub-date 和 until-pub-date 夹住窗口；
//   3. **不要加 sort=published** —— 它会把相关度排序彻底打乱（实测 100 条里只有 5 条
//      标题含量子点）。用默认的相关度排序 + 日期窗口最好：实测 100 条里 67 条标题含量子点；
//   4. 检索字段用 `query.title`（只搜标题）比 `query.bibliographic` 干净得多。

import { CROSSREF_DELAY_MS, MAX_SOURCE_PAGES, SOURCE_PAGE_ROWS, SOURCE_QUERIES } from './config.mjs';
import { normalizeCrossrefAbstract } from './abstract.mjs';
import { fetchWithRetry } from './http.mjs';
import { doiUrl, normalizeDoi, sleep, stripMarkup } from './util.mjs';

/** 实测可用的 select 集合（不要加 subtype / link） */
export const CROSSREF_SELECT = [
  'DOI',
  'title',
  'container-title',
  'ISSN',
  'published',
  'type',
  'URL',
  'abstract',
  'author',
].join(',');

export function buildCrossrefWorksUrl({ query, fromDate, toDate, rows = SOURCE_PAGE_ROWS, offset = 0 } = {}) {
  const filters = ['type:journal-article'];
  if (fromDate) filters.push(`from-pub-date:${fromDate}`);
  if (toDate) filters.push(`until-pub-date:${toDate}`);

  const params = new URLSearchParams({
    'query.title': query,
    filter: filters.join(','),
    rows: String(rows),
    offset: String(offset),
    select: CROSSREF_SELECT,
  });
  if (process.env.CONTACT_EMAIL) params.set('mailto', process.env.CONTACT_EMAIL);

  return `https://api.crossref.org/works?${params.toString()}`;
}

/** Crossref item -> 与 openalex.mapWork 同形的候选记录 */
export function mapCrossrefItem(item) {
  const doi = normalizeDoi(item?.DOI);
  if (!doi) return null;

  const parts = item?.published?.['date-parts']?.[0] ?? [];
  const pubDate = parts.length
    ? `${String(parts[0]).padStart(4, '0')}-${String(parts[1] ?? 1).padStart(2, '0')}-${String(parts[2] ?? 1).padStart(2, '0')}`
    : null;

  const rawAuthors = Array.isArray(item?.author) ? item.author : [];
  const authors = rawAuthors
    .map((a) => [a?.given, a?.family].filter(Boolean).join(' ').trim() || a?.name)
    .filter(Boolean)
    .slice(0, 3);
  if (rawAuthors.length > 3) authors.push('et al.');

  const abstract = normalizeCrossrefAbstract(item?.abstract);

  return {
    doi,
    doi_url: doiUrl(doi),
    title: stripMarkup(Array.isArray(item?.title) ? item.title[0] ?? '' : item?.title ?? ''),
    authors,
    venue: Array.isArray(item?.['container-title']) ? item['container-title'][0] ?? null : null,
    issn_l: Array.isArray(item?.ISSN) ? item.ISSN[0] ?? null : null,
    publisher: item?.publisher ?? null,
    source_type: 'journal',
    pub_date: pubDate,
    pub_year: pubDate ? Number(pubDate.slice(0, 4)) : null,
    oa_status: null,
    pdf_url: null,
    cited_by_count: 0,
    language: item?.language ?? null,
    abstract,
    abstract_source: abstract ? 'crossref' : null,
    sources: ['crossref'],
    publication_types: [],
    type: item?.type ?? 'journal-article',
    openalex_id: null,
  };
}

/** Crossref 要求更保守的速率 */
let lastCall = 0;
async function throttle() {
  const wait = CROSSREF_DELAY_MS - (Date.now() - lastCall);
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();
}

/**
 * 按标题精确匹配期刊论文（给「Google 学术」这类只有标题、没有 DOI 的来源用）。
 * 只返回期刊论文候选，调用方用 titleSimilarity 挑最佳匹配。
 */
export async function fetchCrossrefByTitle(title, { rows = 3 } = {}) {
  if (!title) return [];
  await throttle();
  const url = buildCrossrefWorksUrl({ query: title, rows, offset: 0 });
  try {
    const data = await fetchWithRetry(url, {
      label: `Crossref 标题匹配「${String(title).slice(0, 40)}」`,
      retries: 1,
    });
    const items = Array.isArray(data?.message?.items) ? data.message.items : [];
    return items.map(mapCrossrefItem).filter(Boolean);
  } catch {
    // 匹配失败不该影响整轮
    return [];
  }
}

/**
 * 按关键词检索期刊论文（每词最多 MAX_SOURCE_PAGES 页）。
 * @returns {Promise<{works: object[], total: number}>}
 */
export async function fetchCrossrefWorks({ fromDate, toDate, log = console.log, queries = SOURCE_QUERIES } = {}) {
  const works = [];
  let total = null;

  for (const query of queries) {
    for (let page = 0; page < MAX_SOURCE_PAGES; page += 1) {
      await throttle();
      const url = buildCrossrefWorksUrl({
        query,
        fromDate,
        toDate,
        offset: page * SOURCE_PAGE_ROWS,
      });
      const data = await fetchWithRetry(url, { label: `Crossref 检索「${query}」第 ${page + 1} 页` });

      if (total === null) {
        total = data?.message?.['total-results'] ?? 0;
        log(`   Crossref 报告命中 ${total} 条（关键词「${query}」）`);
      }

      const items = Array.isArray(data?.message?.items) ? data.message.items : [];
      for (const item of items) {
        const mapped = mapCrossrefItem(item);
        if (mapped) works.push(mapped);
      }

      if (items.length < SOURCE_PAGE_ROWS) break;
    }
  }

  return { works, total: total ?? works.length };
}
