// src/sources.mjs
// 多数据源编排：并别跑各源 → 统一去重 → 交给见刊闸门。
//
// 设计原则：
//   1. 单个源失败不影响整轮（allSettled + 逐源日志缓冲），只有全部失败才抛错；
//   2. 各源的日志缓冲后再按源输出，避免并发打印互相穿插；
//   3. 去重只用「DOI 相同」或「归一化标题完全相同」两个硬条件，
//      不搞模糊匹配（参照仓库的 title_similarity ≥ 0.55 容易把不同论文并成一篇）。

import { DEFAULT_SOURCES, SOURCE_IDS, SOURCE_LABELS } from './config.mjs';
import { fetchArxivPublished } from './arxiv.mjs';
import { fetchCrossrefWorks } from './crossref-works.mjs';
import { fetchWorks } from './openalex.mjs';
import { fetchScholarPublished, scholarEnabled } from './scholar.mjs';
import { fetchS2Bulk } from './semanticscholar.mjs';
import { hasPreprintDoi, hasPreprintVenue } from './published.mjs';
import { normalizeDoi, normalizeTitle } from './util.mjs';

/** 每个源的执行器：统一返回 { works, total, dropped } */
const RUNNERS = {
  openalex: ({ fromDate, toDate, log }) =>
    fetchWorks({ fromDate, toDate, log }).then((r) => ({ works: r.works, total: r.total, dropped: 0 })),
  crossref: ({ fromDate, toDate, log }) =>
    fetchCrossrefWorks({ fromDate, toDate, log }).then((r) => ({ works: r.works, total: r.total, dropped: 0 })),
  semanticscholar: ({ fromDate, log }) =>
    fetchS2Bulk({ since: fromDate, log }).then((r) => ({ works: r.works, total: r.total, dropped: 0 })),
  arxiv: ({ fromDate, log }) =>
    fetchArxivPublished({ since: fromDate, log }).then((r) => ({ works: r.works, total: r.total, dropped: r.dropped })),
  scholar: ({ log }) =>
    fetchScholarPublished({ log }).then((r) => ({ works: r.works, total: r.total, dropped: r.dropped })),
};

/**
 * 解析要启用哪些源。
 * @param {string|string[]|null} spec --sources 的取值；null 表示默认
 */
export function resolveSources(spec) {
  let ids;
  if (!spec) {
    ids = [...DEFAULT_SOURCES];
    // 配了 SERPAPI_KEY 才自动加上 Google 学术（可选源）
    if (scholarEnabled()) ids.push('scholar');
  } else if (Array.isArray(spec)) {
    ids = spec.map((s) => String(s).trim()).filter(Boolean);
  } else {
    ids = String(spec).split(',').map((s) => s.trim()).filter(Boolean);
  }

  const unknown = ids.filter((id) => !SOURCE_IDS.includes(id));
  if (unknown.length) {
    throw new Error(`未知数据源：${unknown.join('、')}（可用：${SOURCE_IDS.join('、')}）`);
  }
  if (ids.length === 0) throw new Error('至少要启用一个数据源');
  return [...new Set(ids)];
}

/**
 * 并发跑各源。
 * @returns {Promise<{works: object[], report: object[]}>}
 */
export async function fetchAllSources({ fromDate, toDate, log = console.log, sources } = {}) {
  const ids = Array.isArray(sources) ? sources : resolveSources(sources);

  const tasks = ids.map(async (id) => {
    const lines = [];
    const collect = (msg) => lines.push(String(msg));
    try {
      const result = await RUNNERS[id]({ fromDate, toDate, log: collect });
      return { source: id, ok: true, works: result.works ?? [], total: result.total ?? 0, dropped: result.dropped ?? 0, error: null, lines };
    } catch (err) {
      return { source: id, ok: false, works: [], total: 0, dropped: 0, error: err, lines };
    }
  });

  const settled = await Promise.all(tasks);

  const works = [];
  const report = [];
  for (const r of settled) {
    // 日志统一在这里按源输出，保证顺序可读
    for (const line of r.lines) log(line);
    const label = SOURCE_LABELS[r.source] ?? r.source;
    if (r.ok) {
      log(`   ✓ ${label}：取回 ${r.works.length} 条${r.dropped ? `（另丢弃未达门槛 ${r.dropped} 条）` : ''}`);
    } else {
      log(`   ✗ ${label} 失败（其它源继续）：${r.error?.message ?? r.error}`);
    }
    report.push({
      source: r.source,
      ok: r.ok,
      count: r.works.length,
      total: r.total,
      dropped: r.dropped,
      error: r.ok ? null : String(r.error?.message ?? r.error),
    });
    works.push(...r.works);
  }

  if (report.every((r) => !r.ok)) {
    const first = settled[0];
    throw new Error(`所有数据源都失败了，本轮中止（第一个错误：${first?.error?.message ?? '未知'}）`);
  }

  return { works, report };
}

/** 把两条候选记录合并（sources 取并集，缺的东西互补） */
function mergeInto(target, incoming) {
  target.sources = [...new Set([...(target.sources ?? []), ...(incoming.sources ?? [])])];

  // 预印本 DOI 让位给期刊 DOI：DOI 是记录的身份证，绝不能停在预印本上
  if (hasPreprintDoi(target.doi) && !hasPreprintDoi(incoming.doi)) {
    target.alt_dois = [...new Set([...(target.alt_dois ?? []), target.doi])];
    target.doi = incoming.doi;
    target.doi_url = incoming.doi_url;
  } else if (target.doi !== incoming.doi && !hasPreprintDoi(incoming.doi)) {
    target.alt_dois = [...new Set([...(target.alt_dois ?? []), incoming.doi])];
  }

  // 期刊信息优先：预印本仓储的 venue（arXiv / Research Square…）不能盖住正式期刊名，
  // 否则见刊闸门会把「预印本 + 期刊版」合并后的记录误判成 preprint-venue 丢掉。
  const losingVenue = !target.venue || (hasPreprintVenue(target.venue) && !hasPreprintVenue(incoming.venue));
  if (incoming.venue && losingVenue) target.venue = incoming.venue;
  if (!target.issn_l && incoming.issn_l) target.issn_l = incoming.issn_l;
  if (!target.publisher && incoming.publisher) target.publisher = incoming.publisher;
  if (!target.pub_date && incoming.pub_date) target.pub_date = incoming.pub_date;
  if (!target.pub_year && incoming.pub_year) target.pub_year = incoming.pub_year;
  if (!target.pdf_url && incoming.pdf_url) target.pdf_url = incoming.pdf_url;
  if (!target.oa_status && incoming.oa_status) target.oa_status = incoming.oa_status;
  if (!target.language && incoming.language) target.language = incoming.language;

  // 摘要：谁有就用谁的，两边都有就留更长的（更利于 LLM 总结）
  const targetLen = target.abstract?.length ?? 0;
  const incomingLen = incoming.abstract?.length ?? 0;
  if (incomingLen > targetLen) {
    target.abstract = incoming.abstract;
    target.abstract_source = incoming.abstract_source;
  }

  if (!target.authors?.length && incoming.authors?.length) target.authors = incoming.authors;

  target.cited_by_count = Math.max(target.cited_by_count ?? 0, incoming.cited_by_count ?? 0);

  if (incoming.published && !target.published) {
    target.published = true;
    target.published_source = incoming.published_source ?? null;
  }
  if (incoming.source_type === 'journal' && target.source_type !== 'journal') target.source_type = 'journal';
  if (target.type !== 'journal-article' && incoming.type === 'journal-article') target.type = 'journal-article';

  const types = new Set([...(target.publication_types ?? []), ...(incoming.publication_types ?? [])]);
  if (types.size) target.publication_types = [...types];

  if (!target.arxiv_id && incoming.arxiv_id) target.arxiv_id = incoming.arxiv_id;
  if (!target.s2_id && incoming.s2_id) target.s2_id = incoming.s2_id;
  if (!target.openalex_id && incoming.openalex_id) target.openalex_id = incoming.openalex_id;

  return target;
}

/**
 * 去重：DOI 相同，或归一化标题完全相同。
 * （不用模糊标题匹配，避免把不同论文并成一篇）
 */
export function dedupeCandidates(raws) {
  const byDoi = new Map();
  const byTitle = new Map();

  for (const raw of Array.isArray(raws) ? raws : []) {
    const doi = normalizeDoi(raw?.doi) ?? raw?.doi;
    if (!doi || !raw?.title) continue;
    raw.doi = doi;
    if (!raw.doi_url) raw.doi_url = `https://doi.org/${doi}`;

    const titleKey = normalizeTitle(raw.title);
    const prev = byDoi.get(doi);
    if (prev) {
      mergeInto(prev, raw);
      continue;
    }

    const twin = titleKey ? byTitle.get(titleKey) : null;
    if (twin) {
      // 同标题不同 DOI：并成一条（预印本与正式版就是这种情况）
      const oldDoi = twin.doi;
      mergeInto(twin, raw);
      if (oldDoi !== twin.doi) byDoi.delete(oldDoi);
      byDoi.set(twin.doi, twin);
      byTitle.set(titleKey, twin);
      continue;
    }

    byDoi.set(doi, raw);
    if (titleKey) byTitle.set(titleKey, raw);
  }

  return [...byDoi.values()];
}
