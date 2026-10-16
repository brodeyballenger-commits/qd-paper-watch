// src/arxiv.mjs
// arXiv 在本站**只承担「发现」职责**：预印本本身不进库，
// 必须先用 Semantic Scholar 的批量端点把 arXiv ID 解析成「期刊版本（期刊名 + 期刊 DOI）」，
// 解析不出来的条目直接丢弃。
//
// 这样既借助了 arXiv 的时效性（很多论文先挂 arXiv），又满足「只收已见刊」的要求。
// 实测：8 条 arXiv 结果里 6 条能在 S2 解析出期刊版本（Nature Photonics / JACS / ACS Nano…）。

import { ARXIV_CATEGORIES, ARXIV_DELAY_MS, ARXIV_QUERIES } from './config.mjs';
import { fetchWithRetry } from './http.mjs';
import { s2LookupBatch } from './semanticscholar.mjs';
import { doiUrl, normalizeDoi, sleep, stripMarkup } from './util.mjs';

const API = 'https://export.arxiv.org/api/query';
const MAX_RESULTS = 100;

/** Atom / XML 实体解码（零依赖手工实现，够用即可） */
function decodeEntities(text) {
  return String(text ?? '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

const squash = (text) => decodeEntities(text).replace(/\s+/g, ' ').trim();

function firstTag(chunk, tag) {
  const m = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`).exec(chunk);
  return m ? squash(m[1]) : '';
}

function parseEntry(chunk) {
  const idRaw = firstTag(chunk, 'id');
  const arxivId = idRaw
    .replace(/^https?:\/\/arxiv\.org\/abs\//, '')
    .replace(/v\d+$/, '')
    .trim();
  if (!arxivId) return null;

  const names = [...chunk.matchAll(/<name>([\s\S]*?)<\/name>/g)].map((m) => squash(m[1])).filter(Boolean);
  const authors = names.slice(0, 3);
  if (names.length > 3) authors.push('et al.');

  const primary = /<arxiv:primary_category\b[^>]*term="([^"]+)"/.exec(chunk);

  return {
    arxivId,
    title: firstTag(chunk, 'title'),
    abstract: firstTag(chunk, 'summary') || null,
    authors,
    pub_date: firstTag(chunk, 'published').slice(0, 10) || null,
    updated: firstTag(chunk, 'updated').slice(0, 10) || null,
    category: primary ? primary[1] : null,
    arxivDoi: normalizeDoi(firstTag(chunk, 'arxiv:doi')) || null,
    journalRef: firstTag(chunk, 'arxiv:journal_ref') || null,
    comment: firstTag(chunk, 'arxiv:comment') || null,
  };
}

/** 解析 arXiv Atom feed → 条目数组（纯函数，便于单测） */
export function parseArxivFeed(xml) {
  const text = String(xml ?? '');
  return text
    .split(/<entry\b[^>]*>/)
    .slice(1)
    .map(parseEntry)
    .filter(Boolean);
}

/**
 * @param {object} [opts] { query, categories, maxResults, raw }
 *   `raw: true` 时把 query 当成 arXiv 原生检索式（可含 `AND`/`OR`/字段前缀），
 *   否则按老行为把每个词包成 `all:"…"` 短语。
 */
export function buildArxivUrl({ query, categories = ARXIV_CATEGORIES, maxResults = MAX_RESULTS, raw = false } = {}) {
  const list = (Array.isArray(query) ? query : [query]).filter(Boolean);
  const terms = (raw ? list.map((q) => `(${q})`) : list.map((q) => `all:"${q}"`)).join(' OR ');
  const cats = categories.map((c) => `cat:${c}`).join(' OR ');
  const searchQuery = terms && cats ? `(${terms}) AND (${cats})` : terms || cats;

  const params = new URLSearchParams({
    search_query: searchQuery,
    start: '0',
    max_results: String(maxResults),
    sortBy: 'submittedDate',
    sortOrder: 'descending',
  });
  return `${API}?${params.toString()}`;
}

/**
 * 拉取 arXiv 条目（只发现，不判定见刊）。
 *
 * `since`（YYYY-MM-DD）是**必须的**窗口下界：arXiv 的 `all:"…"` 检索会命中很久以前的老预印本
 * （实测一次 20 条结果里混进 2018–2024 年的），不挡住就会让「最新论文」站混进几年前的旧文。
 *
 * @param {object} [opts] { log, queries, maxResults, since, delayMs }
 */
export async function fetchArxivEntries({
  log = console.log,
  queries = ARXIV_QUERIES,
  raw = true,
  maxResults = MAX_RESULTS,
  since = null,
  delayMs = ARXIV_DELAY_MS,
} = {}) {
  const byId = new Map();

  for (const query of queries) {
    const url = buildArxivUrl({ query, maxResults, raw });
    const xml = await fetchWithRetry(url, {
      expectJson: false,
      label: `arXiv「${query}」`,
    });
    const entries = parseArxivFeed(xml);
    // 时间窗口：只保留窗口内提交的预印本；没写日期的保守丢弃
    const kept = since ? entries.filter((e) => (e.pub_date ?? '') >= since) : entries;
    for (const e of kept) if (!byId.has(e.arxivId)) byId.set(e.arxivId, e);
    log(`   arXiv「${query}」：${entries.length} 条${since ? `，窗口内（${since} 起）${kept.length} 条` : ''}`);
    await sleep(delayMs);
  }

  return [...byId.values()];
}

/**
 * 把 arXiv 条目解析成「已见刊」候选：
 * 先用 Semantic Scholar 批量端点换期刊版本，换不到再看 arXiv 自己带的 <arxiv:doi>。
 *
 * @returns {{works: object[], dropped: number, resolved: number}}
 */
export async function resolveArxivEntries(entries, { log = console.log } = {}) {
  const list = Array.isArray(entries) ? entries : [];
  if (list.length === 0) return { works: [], dropped: 0, resolved: 0 };

  const ids = list.map((e) => `ARXIV:${e.arxivId}`);
  let s2Failed = null;
  let resolved;
  try {
    resolved = await s2LookupBatch(ids);
  } catch (err) {
    // S2 批量端点未带 key 时实测必 429（Too Many Requests）。它挂了不代表 arXiv 没用：
    // 不少作者会把正式版 DOI 回填到 <arxiv:doi>，这批条目照样能判定为已见刊。
    s2Failed = err;
    resolved = new Array(list.length).fill(null);
    log(`   ⚠ arXiv：Semantic Scholar 批量解析失败（${err?.message ?? err}），本轮只保留 arXiv 自带期刊 DOI 的条目`);
  }

  const works = [];
  let dropped = 0;

  for (let i = 0; i < list.length; i += 1) {
    const entry = list[i];
    const s2 = resolved[i];

    const s2Doi = normalizeDoi(s2?.externalIds?.DOI);
    const journal = s2?.journal?.name ?? null;
    const doi = s2Doi || entry.arxivDoi;

    // 没有期刊 DOI（无论来自 S2 还是 arXiv 自己标注）→ 尚未见刊，丢弃
    if (!doi) {
      dropped += 1;
      continue;
    }

    const venue = journal || entry.journalRef || null;
    const abstract = entry.abstract || stripMarkup(s2?.abstract || '') || null;
    const date = (s2?.publicationDate && String(s2.publicationDate).slice(0, 10)) || entry.pub_date || null;

    works.push({
      doi,
      doi_url: doiUrl(doi),
      title: stripMarkup(s2?.title || entry.title || ''),
      authors: entry.authors,
      venue,
      issn_l: null,
      publisher: s2?.journal?.publisher ?? null,
      source_type: 'journal',
      pub_date: date,
      pub_year: date ? Number(String(date).slice(0, 4)) || null : null,
      oa_status: s2?.openAccessPdf?.url ? 'oa' : null,
      pdf_url: s2?.openAccessPdf?.url ?? `https://arxiv.org/pdf/${entry.arxivId}`,
      cited_by_count: s2?.citationCount ?? 0,
      language: null,
      abstract,
      abstract_source: abstract ? (entry.abstract ? 'arxiv' : 'semanticscholar') : null,
      sources: ['arxiv', 'semanticscholar'],
      publication_types: Array.isArray(s2?.publicationTypes) ? s2.publicationTypes : [],
      type: 'article',
      // 我们刚刚亲自确认过期刊版本，直接标记见刊，不再走通用兜底判定
      published: true,
      published_source: s2Doi ? 'semanticscholar' : 'arxiv-doi',
      arxiv_id: entry.arxivId,
      s2_id: s2?.paperId ?? null,
      openalex_id: null,
    });
  }

  const reason = s2Failed ? '（Semantic Scholar 不可用，未能核对期刊版本）' : '（尚未见刊）';
  log(`   arXiv：${list.length} 条预印本 → 解析出期刊版本 ${works.length} 条，丢弃 ${dropped} 条${reason}`);
  return { works, dropped, resolved: works.length, s2_failed: Boolean(s2Failed) };
}

/** 一步到位：发现（带时间窗口）+ 解析 */
export async function fetchArxivPublished({ log = console.log, queries = ARXIV_QUERIES, since = null, delayMs = ARXIV_DELAY_MS } = {}) {
  const entries = await fetchArxivEntries({ log, queries, since, delayMs });
  const { works, dropped, s2_failed: s2Failed } = await resolveArxivEntries(entries, { log });
  return { works, total: entries.length, dropped, s2_failed: s2Failed };
}
