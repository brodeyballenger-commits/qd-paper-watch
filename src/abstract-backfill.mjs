// src/abstract-backfill.mjs
// 摘要兜底：多源抓到的新论文里有相当一部分没有摘要（实测 334 篇里 101 篇，其中 28 篇属于主方向 QD-LED），
// 而没有摘要就没法生成有价值的「创新点」总结（只能写「数据库未收录摘要」）。
//
// 这里用**批量**接口补摘要，成本极低：
//   1) Semantic Scholar /paper/batch：一次最多 500 个 DOI，直接给 abstract；
//   2) OpenAlex /works?filter=doi:a|b|c：一次最多 50 个 DOI，给 abstract_inverted_index。
// 两步都是每轮几次请求，不用逐篇查（逐篇查是之前 Crossref 兜底的做法，60 次/轮却 0 命中）。

import { restoreAbstract } from './abstract.mjs';
import { fetchWithRetry } from './http.mjs';
import { normalizeDoi } from './util.mjs';

const OPENALEX_BATCH = 50;

/** 摘要短到这个程度基本是占位符/残片，视为没有 */
const MIN_ABSTRACT_LENGTH = 60;

/** 需要补摘要的原始记录（按 DOI 去重，缺 DOI 的跳过） */
export function collectMissingAbstract(raws) {
  const out = [];
  const seen = new Set();
  for (const raw of raws ?? []) {
    const doi = normalizeDoi(raw?.doi);
    if (!doi || seen.has(doi)) continue;
    const abstract = typeof raw.abstract === 'string' ? raw.abstract.trim() : '';
    if (abstract.length >= MIN_ABSTRACT_LENGTH) continue;
    seen.add(doi);
    out.push(doi);
  }
  return out;
}

function applyAbstract(raws, doi, abstract, source) {
  if (!abstract) return false;
  let hit = false;
  for (const raw of raws) {
    if (normalizeDoi(raw?.doi) !== doi) continue;
    raw.abstract = abstract;
    raw.abstract_source = source;
    hit = true;
  }
  return hit;
}

/** 第一步：Semantic Scholar 批量查 DOI → abstract（一次请求最多 500 篇） */
async function fillFromS2(raws, dois, { s2Lookup = null } = {}) {
  const lookup = s2Lookup ?? (await import('./semanticscholar.mjs')).s2LookupBatch;
  const ids = dois.map((doi) => `DOI:${doi}`);
  const results = await lookup(ids, { fields: 'title,abstract' });

  let filled = 0;
  for (let i = 0; i < dois.length; i += 1) {
    const abstract = results?.[i]?.abstract;
    if (typeof abstract === 'string' && abstract.trim().length >= MIN_ABSTRACT_LENGTH) {
      if (applyAbstract(raws, dois[i], abstract.trim(), 'semanticscholar')) filled += 1;
    }
  }
  return filled;
}

export function buildOpenAlexDoiFilterUrl(dois) {
  const params = new URLSearchParams({
    filter: `doi:${dois.join('|')}`,
    select: 'doi,abstract_inverted_index',
    'per-page': String(OPENALEX_BATCH),
  });
  if (process.env.CONTACT_EMAIL) params.set('mailto', process.env.CONTACT_EMAIL);
  if (process.env.OPENALEX_API_KEY) params.set('api_key', process.env.OPENALEX_API_KEY);
  return `https://api.openalex.org/works?${params.toString()}`;
}

/** 第二步：OpenAlex 批量查 DOI → 倒排索引 → 还原摘要（一次请求最多 50 篇） */
async function fillFromOpenAlex(raws, dois, { fetchJson = fetchWithRetry } = {}) {
  let filled = 0;
  for (let start = 0; start < dois.length; start += OPENALEX_BATCH) {
    const chunk = dois.slice(start, start + OPENALEX_BATCH);
    let data;
    try {
      data = await fetchJson(buildOpenAlexDoiFilterUrl(chunk), {
        label: `OpenAlex 摘要兜底（${chunk.length} 篇）`,
        retries: 1,
      });
    } catch {
      // 兜底失败不能影响整轮构建
      continue;
    }

    for (const work of data?.results ?? []) {
      const doi = normalizeDoi(work?.doi);
      if (!doi) continue;
      const abstract = restoreAbstract(work?.abstract_inverted_index);
      // 太短的（< MIN_ABSTRACT_LENGTH）仍然写进去，但那只是残片，不算「补上」
      if (!abstract) continue;
      applyAbstract(raws, doi, abstract, 'openalex');
      if (abstract.length >= MIN_ABSTRACT_LENGTH) filled += 1;
    }
  }
  return filled;
}

/**
 * 给一批原始记录补摘要，就地修改并返回统计。
 * 只在「确实缺摘要」时才发请求；两个接口都失败也不抛错（构建继续）。
 *
 * @param {object[]} raws
 * @param {object} [opts] { log, s2Lookup, fetchJson }
 * @returns {Promise<{missing:number, filled:number, semanticscholar:number, openalex:number, stillMissing:number}>}
 */
export async function backfillAbstracts(raws, { log = console.log, s2Lookup, fetchJson } = {}) {
  const dois = collectMissingAbstract(raws);
  const stats = {
    missing: dois.length,
    filled: 0,
    semanticscholar: 0,
    openalex: 0,
    stillMissing: 0,
  };

  if (dois.length === 0) return stats;

  try {
    stats.semanticscholar = await fillFromS2(raws, dois, { s2Lookup });
  } catch {
    // S2 挂了就走 OpenAlex，全都失败时保持原样
  }

  const remaining = collectMissingAbstract(raws);
  if (remaining.length) {
    try {
      stats.openalex = await fillFromOpenAlex(raws, remaining, { fetchJson });
    } catch {
      // 同上：补摘要只是加分项
    }
  }

  stats.filled = stats.semanticscholar + stats.openalex;
  stats.stillMissing = collectMissingAbstract(raws).length;
  if (stats.filled) {
    log(`   摘要兜底：缺 ${stats.missing} 篇 → 补上 ${stats.filled} 篇（Semantic Scholar ${stats.semanticscholar}、OpenAlex ${stats.openalex}），仍缺 ${stats.stillMissing} 篇`);
  } else {
    log(`   摘要兜底：缺 ${stats.missing} 篇，两个兜底接口都没补到（保持「数据库未收录摘要」）`);
  }

  return stats;
}
