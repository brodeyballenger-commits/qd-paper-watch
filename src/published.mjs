// src/published.mjs
// 「是否已经见刊」——本站的铁门槛。
//
// 背景：arXiv / Zenodo / SSRN 这类仓储上的预印本不是最终见刊版本，
// 用户明确要求只收「已经见刊」的论文，所以：
//   1. arXiv 只用来「发现」题目，必须经 Semantic Scholar 解析出期刊 DOI 才算见刊；
//   2. 每个源都用各自的原生字段判定，判定不了就丢；
//   3. 存量账本里的老记录用 is_preprint 回填（幂等，每次构建都会自愈）。
//
// 判定口径只到「存在正式期刊版本」为止，不等同于 SCI 收录/分区。

import { PREPRINT_DOI_PREFIXES, PREPRINT_SOURCE_HINTS } from './config.mjs';

/** DOI 本身暴露了它来自预印本仓储（arXiv 自己的 DOI、Zenodo、SSRN、bioRxiv…） */
export function hasPreprintDoi(doi) {
  const d = String(doi ?? '').toLowerCase();
  if (!d) return false;
  return PREPRINT_DOI_PREFIXES.some((p) => d.startsWith(p));
}

/** 期刊名里写着 arXiv / repository / Research Square 之类，说明不是正式期刊版本 */
export function hasPreprintVenue(venue) {
  const v = String(venue ?? '').toLowerCase();
  if (!v) return false;
  return PREPRINT_SOURCE_HINTS.some((h) => v.includes(h));
}

function sourceSet(raw) {
  return new Set(Array.isArray(raw?.sources) ? raw.sources : []);
}

/**
 * 判定一条候选记录是否已经见刊。
 *
 * @param {object} raw 与 openalex.mapWork 同形的候选记录（各源适配器都产出这个形状）
 * @returns {{published: boolean, published_source: string|null, reason: string|null}}
 */
export function isPublishedWork(raw) {
  if (!raw || !raw.doi) {
    return { published: false, published_source: null, reason: 'no-doi' };
  }

  // 来源自己已经解析出期刊版本（例如 arXiv → Semantic Scholar 拿到了期刊 DOI）
  if (raw.published === true) {
    return { published: true, published_source: raw.published_source ?? 'source', reason: null };
  }

  if (hasPreprintDoi(raw.doi)) {
    return { published: false, published_source: null, reason: 'preprint-doi' };
  }
  if (hasPreprintVenue(raw.venue)) {
    return { published: false, published_source: null, reason: 'preprint-venue' };
  }

  const sources = sourceSet(raw);
  const types = Array.isArray(raw.publication_types) ? raw.publication_types : [];

  // Crossref：我们只检索 type:journal-article，能回来就是期刊论文
  if (sources.has('crossref') && raw.type === 'journal-article') {
    return { published: true, published_source: 'crossref', reason: null };
  }

  // Semantic Scholar：JournalArticle + 有期刊名才算见刊
  // （部分记录 publicationTypes 为 null，此时以「有期刊名」为准，
  //   预印本仓储的 venue 已经在上面被 hasPreprintVenue 拦掉了）
  if (sources.has('semanticscholar') && raw.venue && (types.includes('JournalArticle') || types.length === 0)) {
    return { published: true, published_source: 'semanticscholar', reason: null };
  }

  // OpenAlex：primary_location.source.type === 'journal'
  if (sources.has('openalex') && raw.source_type === 'journal' && (raw.type === 'article' || !raw.type)) {
    return { published: true, published_source: 'openalex', reason: null };
  }

  // 兜底：源原生字段告诉我们它是期刊论文（例如没有 type 字段，但 source_type 是 journal）
  if (raw.source_type === 'journal' && (raw.type === 'article' || raw.type === 'journal-article' || !raw.type)) {
    return { published: true, published_source: raw.published_source ?? 'source', reason: null };
  }

  return { published: false, published_source: null, reason: 'no-journal-evidence' };
}

/**
 * 批量过闸门。
 * @returns {{published: object[], dropped: number, stats: Map<string, number>}}
 */
export function applyPublishedGate(raws) {
  const published = [];
  const stats = new Map();

  for (const raw of Array.isArray(raws) ? raws : []) {
    const verdict = isPublishedWork(raw);
    if (verdict.published) {
      raw.published = true;
      raw.published_source = verdict.published_source;
      published.push(raw);
      continue;
    }
    const key = verdict.reason ?? 'unknown';
    stats.set(key, (stats.get(key) ?? 0) + 1);
  }

  let dropped = 0;
  for (const n of stats.values()) dropped += n;

  return { published, dropped, stats };
}

/**
 * 给存量账本补 published / sources（老记录早于多源改造）。
 * 幂等且只增不减：已判定为见刊的记录永远不会被降级，所以不必写一次性迁移脚本。
 *
 * @returns {number} 本次实际改动了几条
 */
export function applyPublishedFieldsToLedger(papers) {
  let changed = 0;

  for (const p of Array.isArray(papers) ? papers : []) {
    let touched = false;

    if (!Array.isArray(p.sources) || p.sources.length === 0) {
      p.sources = ['openalex'];
      if (p.abstract_source === 'crossref') p.sources.push('crossref');
      touched = true;
    }

    if (typeof p.published !== 'boolean') {
      p.published = p.is_preprint !== true;
      p.published_source = p.published ? p.sources[0] ?? 'openalex' : null;
      touched = true;
    }

    if (!('published_source' in p)) {
      p.published_source = p.published ? p.sources[0] ?? 'openalex' : null;
      touched = true;
    }

    if (touched) changed += 1;
  }

  return changed;
}
