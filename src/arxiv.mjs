// src/arxiv.mjs
// arXiv 在本站**只承担「发现」职责**：预印本本身不进库，
// 必须先用 Semantic Scholar 的批量端点把 arXiv ID 解析成「期刊版本（期刊名 + 期刊 DOI）」，
// 解析不出来的条目直接丢弃。
//
// 这样既借助了 arXiv 的时效性（很多论文先挂 arXiv），又满足「只收已见刊」的要求。
// 实测：8 条 arXiv 结果里 6 条能在 S2 解析出期刊版本（Nature Photonics / JACS / ACS Nano…）。

import { ARXIV_CATEGORIES, ARXIV_DELAY_MS, SOURCE_QUERIES } from './config.mjs';
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

export function buildArxivUrl({ query, categories = ARXIV_CATEGORIES, maxResults = MAX_RESULTS } = {}) {
  const terms = (Array.isArray(query) ? query : [query]).filter(Boolean).map((q) => `all:"${q}"`).join(' OR ');
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

/** 拉取近期 arXiv 条目（只发现，不判定见刊） */
export async function fetchArxivEntries({ log = console.log, queries = SOURCE_QUERIES, maxResults = MAX_RESULTS } = {}) {
  const byId = new Map();

  for (const query of queries) {
    const url = buildArxivUrl({ query, maxResults });
    const xml = await fetchWithRetry(url, {
      expectJson: false,
      label: `arXiv「${query}」`,
    });
    const entries = parseArxivFeed(xml);
    for (const e of entries) if (!byId.has(e.arxivId)) byId.set(e.arxivId, e);
    log(`   arXiv「${query}」：${entries.length} 条`);
    await sleep(ARXIV_DELAY_MS);
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
  const resolved = await s2LookupBatch(ids);
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

  log(`   arXiv：${list.length} 条预印本 → 解析出期刊版本 ${works.length} 条，丢弃 ${dropped} 条（尚未见刊）`);
  return { works, dropped, resolved: works.length };
}

/** 一步到位：发现 + 解析 */
export async function fetchArxivPublished({ log = console.log, queries = SOURCE_QUERIES } = {}) {
  const entries = await fetchArxivEntries({ log, queries });
  const { works, dropped } = await resolveArxivEntries(entries, { log });
  return { works, total: entries.length, dropped };
}
