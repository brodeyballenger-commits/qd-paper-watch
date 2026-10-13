// src/openalex.mjs
// 主数据源。经实测：api.openalex.org 可达，且支持我们需要的全部筛选器。
// 注意：`from_created_date` 需要付费计划（实测报 "Plan upgrade required"），
// 所以「新论文」的判定用 from_publication_date + 本地 DOI 去重。

import { PAGE_SIZE, REQUEST_DELAY_MS, TOPIC_IDS } from './config.mjs';
import { restoreAbstract } from './abstract.mjs';
import { fetchWithRetry } from './http.mjs';
import { doiUrl, normalizeDoi, sleep, stripMarkup } from './util.mjs';

const SELECT = [
  'id',
  'doi',
  'title',
  'publication_date',
  'publication_year',
  'type',
  'primary_location',
  'open_access',
  'best_oa_location',
  'cited_by_count',
  'language',
  'is_retracted',
  'authorships',
  'abstract_inverted_index',
].join(',');

const MAX_PAGES = 25;

export function buildWorksUrl({ fromDate, toDate, cursor = '*' } = {}) {
  const filters = [
    `primary_topic.id:${TOPIC_IDS.join('|')}`,
    `from_publication_date:${fromDate}`,
    'type:article',
    'is_retracted:false',
  ];
  if (toDate) filters.push(`to_publication_date:${toDate}`);

  const params = new URLSearchParams({
    filter: filters.join(','),
    sort: 'publication_date:desc',
    'per-page': String(PAGE_SIZE),
    cursor,
    select: SELECT,
  });
  if (process.env.CONTACT_EMAIL) params.set('mailto', process.env.CONTACT_EMAIL);

  return `https://api.openalex.org/works?${params.toString()}`;
}

/** OpenAlex work -> 我们自己的扁平记录 */
export function mapWork(work) {
  const src = work?.primary_location?.source ?? null;
  const authorships = Array.isArray(work?.authorships) ? work.authorships : [];

  const authors = authorships
    .map((a) => a?.author?.display_name)
    .filter(Boolean)
    .slice(0, 3);
  if (authorships.length > 3) authors.push('et al.');

  const doi = normalizeDoi(work?.doi);
  if (!doi) return null; // 没有 DOI 的记录对我们没有意义

  const abstract = restoreAbstract(work?.abstract_inverted_index);

  return {
    doi,
    doi_url: doiUrl(doi),
    title: stripMarkup(work?.title || ''),
    authors,
    venue: src?.display_name ?? null,
    issn_l: src?.issn_l ?? null,
    publisher: src?.host_organization_name ?? null,
    source_type: src?.type ?? null,
    type: work?.type ?? null,
    sources: ['openalex'],
    pub_date: work?.publication_date ?? null,
    pub_year: work?.publication_year ?? null,
    oa_status: work?.open_access?.oa_status ?? null,
    pdf_url: work?.best_oa_location?.pdf_url ?? work?.primary_location?.pdf_url ?? null,
    cited_by_count: work?.cited_by_count ?? 0,
    language: work?.language ?? null,
    abstract,
    abstract_source: abstract ? 'openalex' : null,
    openalex_id: work?.id ?? null,
  };
}

/**
 * 翻页拉取。返回 { works, total }；total 是 OpenAlex 报告的总命中数。
 * 任何一页最终失败都会抛出，让调用方中止整轮，绝不写入半成品数据。
 */
export async function fetchWorks({ fromDate, toDate, log = console.log } = {}) {
  const works = [];
  let cursor = '*';
  let page = 0;
  let total = null;

  while (page < MAX_PAGES) {
    const url = buildWorksUrl({ fromDate, toDate, cursor });
    const data = await fetchWithRetry(url, { label: `OpenAlex works 第 ${page + 1} 页` });

    if (total === null) {
      total = data?.meta?.count ?? 0;
      log(`   OpenAlex 报告命中 ${total} 条`);
    }

    const results = Array.isArray(data?.results) ? data.results : [];
    for (const raw of results) {
      const mapped = mapWork(raw);
      if (mapped) works.push(mapped);
    }

    cursor = data?.meta?.next_cursor ?? null;
    page += 1;

    if (!cursor || results.length === 0) break;
    await sleep(REQUEST_DELAY_MS);
  }

  if (page >= MAX_PAGES) {
    log(`   ⚠ 已达翻页上限 ${MAX_PAGES} 页，结果可能不完整`);
  }

  return { works, total: total ?? works.length };
}
