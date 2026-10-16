// src/openalex.mjs
// 主数据源。经实测：api.openalex.org 可达，且支持我们需要的全部筛选器。
// 注意：`from_created_date` 需要付费计划（实测报 "Plan upgrade required"），
// 所以「新论文」的判定用 from_publication_date + 本地 DOI 去重。

import { PAGE_SIZE, REQUEST_DELAY_MS, TOPIC_IDS } from './config.mjs';
import { restoreAbstract } from './abstract.mjs';
import { fetchWithRetry } from './http.mjs';
import { doiUrl, isoDate, normalizeDoi, sleep, stripMarkup } from './util.mjs';

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
/**
 * 无 api_key 时 OpenAlex 只放行 `cursor=*` 的第一页（实测 2026-10 起第 2 页直接
 * `HTTP 401 API key required for cursor paging`）。为了在没配 key 的情况下仍然把
 * 整个窗口抓全，改用**日期切片**：把窗口切成若干天，每片都用 `cursor=*` 取第一页。
 */
export const OPENALEX_SLICE_DAYS = 7;
/** 切片数量上限（25 页 × 7 天 ≈ 半年，够 --days=400 的极端回填） */
const MAX_SLICES = 60;

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
  // 免费 API key 把每日额度提到 10 倍。不填时额度按出口 IP 共享，
  // GitHub Actions 那种共享 IP 上经常被别人用光（实测 HTTP 429 Insufficient budget）。
  if (process.env.OPENALEX_API_KEY) params.set('api_key', process.env.OPENALEX_API_KEY);

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
 * 把 [fromDate, toDate] 按 sliceDays 天切成若干片（从最新往旧切，日期均为 YYYY-MM-DD）。
 * 供「没有 api_key、不能翻页」时用：每片都从 cursor=* 开始，等于把一个大窗口拆成多个第一页。
 *
 * @returns {{from: string, to: string}[]}
 */
export function sliceWindows(fromDate, toDate, sliceDays = OPENALEX_SLICE_DAYS) {
  if (!fromDate || !(sliceDays > 0)) return [];
  const end = toDate || isoDate();
  if (fromDate > end) return [];

  const slices = [];
  let cursor = end;
  while (slices.length < MAX_SLICES) {
    const startDate = new Date(`${cursor}T00:00:00Z`);
    startDate.setUTCDate(startDate.getUTCDate() - (sliceDays - 1));
    const start = isoDate(startDate);
    const from = start < fromDate ? fromDate : start;
    slices.push({ from, to: cursor });
    if (from === fromDate) break;

    const prev = new Date(`${from}T00:00:00Z`);
    prev.setUTCDate(prev.getUTCDate() - 1);
    cursor = isoDate(prev);
  }
  return slices;
}

/** 取一页；返回 { works, total, next }。第一页失败会让整个源判定为失败（由调用方决定）。 */
async function fetchWorksPage({ fromDate, toDate, cursor = '*', page = 1, log = console.log, announce = page === 1 }) {
  const url = buildWorksUrl({ fromDate, toDate, cursor });
  const data = await fetchWithRetry(url, { label: `OpenAlex works 第 ${page} 页` });

  const total = data?.meta?.count ?? 0;
  if (announce) log(`   OpenAlex 报告命中 ${total} 条`);
  const results = Array.isArray(data?.results) ? data.results : [];

  return {
    works: results.map(mapWork).filter(Boolean),
    total,
    next: data?.meta?.next_cursor ?? null,
  };
}

/**
 * 翻页拉取。返回 `{ works, total, partial }`；`total` 是 OpenAlex 报告的总命中数，
 * `partial` 表示结果可能不完整（翻页中途失败）。
 *
 * 失败策略（2026-10 起 OpenAlex 的政策改动逼出来的）：
 *   - 第一页失败 → 抛出，让上层把整个源记成 ok:false；
 *   - 第 2 页起失败 → **不再抛**。以前一页失败会把已经取回的 200 条全部丢掉，
 *     线上实测 source_stats.openalex 直接变成 count=0，主源等于全废；
 *   - 若失败原因是「没有 key 不能 cursor 翻页」，自动退回日期切片继续抓，
 *     没配 key 也能把整个窗口抓全（代价是多几次请求）。
 */
export async function fetchWorks({ fromDate, toDate, log = console.log } = {}) {
  const byDoi = new Map();
  let total = null;
  let partial = false;

  const absorb = (page) => {
    if (total === null) total = page.total ?? null;
    for (const work of page.works) if (!byDoi.has(work.doi)) byDoi.set(work.doi, work);
  };

  const first = await fetchWorksPage({ fromDate, toDate, cursor: '*', page: 1, log });
  absorb(first);

  let cursor = first.next;
  let pages = 1;

  while (cursor && pages < MAX_PAGES) {
    let page;
    try {
      page = await fetchWorksPage({ fromDate, toDate, cursor, page: pages + 1, log });
    } catch (err) {
      const message = err?.message ?? '';
      const cannotPage = /cursor paging/i.test(message);

      if (cannotPage && fromDate && !process.env.OPENALEX_API_KEY) {
        log('   ⚠ OpenAlex 未配 api_key，官方已禁止 cursor 翻页；改用日期切片继续抓取');
        const slices = sliceWindows(fromDate, toDate);
        // 第 1 片与刚才那页覆盖同一段时间，跳过以免重复请求
        for (const slice of slices.slice(1)) {
          if (pages >= MAX_SLICES) break;
          await sleep(REQUEST_DELAY_MS);
          absorb(await fetchWorksPage({ fromDate: slice.from, toDate: slice.to, cursor: '*', page: 1, log, announce: false }));
          pages += 1;
        }
        partial = true;
        log(`   OpenAlex：日期切片 ${slices.length} 片，累计 ${byDoi.size} 条`);
        cursor = null;
        break;
      }

      partial = true;
      log(`   ⚠ OpenAlex 第 ${pages + 1} 页失败，保留已取回的 ${byDoi.size} 条（${message || '未知错误'}）`);
      if (cannotPage) {
        log('      提示：配 OPENALEX_API_KEY（免费）即可恢复完整抓取，见 README §2.1');
      }
      cursor = null;
      break;
    }

    absorb(page);
    pages += 1;
    cursor = page.next;
    if (page.works.length === 0) break;
    await sleep(REQUEST_DELAY_MS);
  }

  if (pages >= MAX_PAGES) {
    partial = true;
    log(`   ⚠ 已达翻页上限 ${MAX_PAGES} 页，结果可能不完整`);
  }

  return { works: [...byDoi.values()], total: total ?? byDoi.size, partial };
}
