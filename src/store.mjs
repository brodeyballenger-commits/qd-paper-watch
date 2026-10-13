// src/store.mjs
// 主账本：只增不删，按 DOI 去重，原子写入。
// 铁律：任何解析失败都不要覆盖已有数据（宁可这轮什么都不做，也不能把线上数据写坏）。

import fs from 'node:fs/promises';
import { dayDiff, normalizeDoi, normalizeTitle, sha256, writeFileAtomic } from './util.mjs';

/** 没有 DOI 的记录对我们没有意义，调用方应先过滤掉。 */

export async function loadJson(file, fallback = null) {
  let raw;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }

  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`数据文件已损坏，拒绝覆盖：${file}\n  ${err.message}`);
  }
}

export async function saveJsonAtomic(file, value) {
  await writeFileAtomic(fs, file, `${JSON.stringify(value, null, 2)}\n`);
}

/** 未来出版日期：实测存在 pub_date=2027-01-01 的「提前上线」论文 */
export function isFutureDate(pubDate, now = new Date()) {
  if (!pubDate) return false;
  const t = Date.parse(`${pubDate}T00:00:00Z`);
  if (Number.isNaN(t)) return false;
  return t - now.getTime() > 30 * 86400000;
}

/**
 * 把抓取到的原始记录变成完整的主账本记录。
 * @param {object} raw openalex.mapWork 的产物
 * @param {object} opts { now, directions, isPreprint }
 */
export function makeRecord(raw, { now, directions = [], isPreprint = false } = {}) {
  const abstract = raw.abstract ?? null;
  const suspect = isFutureDate(raw.pub_date, new Date(now));
  const today = now.slice(0, 10);

  return {
    id: raw.doi,
    doi: raw.doi,
    doi_url: raw.doi_url,
    title: raw.title,
    title_zh: null,
    title_key: normalizeTitle(raw.title),
    authors: raw.authors ?? [],
    venue: raw.venue ?? null,
    issn_l: raw.issn_l ?? null,
    source_type: raw.source_type ?? null,
    is_preprint: isPreprint,
    // 这一条记录是从哪些源发现的（多源去重后取并集），以及它是否已经见刊
    sources: Array.isArray(raw.sources) && raw.sources.length ? [...new Set(raw.sources)] : ['openalex'],
    published: typeof raw.published === 'boolean' ? raw.published : isPreprint !== true,
    published_source: raw.published_source ?? null,
    alt_doi: Array.isArray(raw.alt_dois) && raw.alt_dois.length ? normalizeDoi(raw.alt_dois[0]) ?? raw.alt_dois[0] : null,
    pub_date: raw.pub_date ?? null,
    pub_year: raw.pub_year ?? null,
    date_suspect: suspect,
    // 排序用日期：可疑的未来日期退回「首次发现」，否则会被永久顶在榜首
    sort_date: suspect ? today : raw.pub_date ?? today,
    oa_status: raw.oa_status ?? null,
    pdf_url: raw.pdf_url ?? null,
    cited_by_count: raw.cited_by_count ?? 0,
    abstract,
    abstract_hash: abstract ? sha256(abstract) : null,
    abstract_source: raw.abstract_source ?? null,
    abstract_missing: !abstract,
    directions,
    novelty_score: null,
    novelty_reason: null,
    innovation_zh: null,
    method_zh: null,
    keywords_zh: [],
    summary_source: null,
    llm_model: null,
    llm_at: null,
    pending_summary: true,
    first_seen: now,
    last_updated: now,
  };
}

/** 保留上一轮已经生成好的 LLM 结果，避免摘要没变还重复花钱 */
function carryLlm(prev) {
  return {
    title_zh: prev.title_zh ?? null,
    novelty_score: prev.novelty_score ?? null,
    novelty_reason: prev.novelty_reason ?? null,
    innovation_zh: prev.innovation_zh ?? null,
    method_zh: prev.method_zh ?? null,
    keywords_zh: prev.keywords_zh ?? [],
    summary_source: prev.summary_source ?? null,
    llm_model: prev.llm_model ?? null,
    llm_at: prev.llm_at ?? null,
    pending_summary: prev.pending_summary ?? true,
  };
}

const withinDays = (a, b, days) => {
  const da = a.sort_date || a.pub_date || a.first_seen?.slice(0, 10);
  const db = b.sort_date || b.pub_date || b.first_seen?.slice(0, 10);
  if (!da || !db) return true;
  return Math.abs(dayDiff(da, db)) <= days;
};

/**
 * 合并新旧记录。
 * @returns {{papers: object[], stats: object}}
 */
export function mergeRecords(existing, incoming, { now }) {
  const byDoi = new Map(existing.map((p) => [p.doi, p]));
  const byTitle = new Map(existing.filter((p) => p.title_key).map((p) => [p.title_key, p]));

  const stats = { added: 0, updated: 0, unchanged: 0, preprintMerged: 0 };

  for (const rec of incoming) {
    const prev = byDoi.get(rec.doi);

    if (prev) {
      const abstractChanged = (prev.abstract_hash ?? null) !== (rec.abstract_hash ?? null);
      const merged = {
        ...prev,
        ...rec,
        first_seen: prev.first_seen, // 首次发现时间不可变
        last_updated: now,
        directions: [...new Set([...(prev.directions ?? []), ...(rec.directions ?? [])])],
        // 多源发现的痕迹只增不减；只要任一来源证明它已见刊，就算已见刊
        sources: [...new Set([...(prev.sources ?? []), ...(rec.sources ?? [])])],
        published: prev.published === true || rec.published === true,
        published_source: rec.published_source ?? prev.published_source ?? null,
        alt_doi: prev.alt_doi ?? null,
      };

      if (!abstractChanged) {
        Object.assign(merged, carryLlm(prev));
        stats.unchanged += 1;
      } else {
        // 摘要变了 -> 之前的总结作废，等待重新生成
        merged.pending_summary = true;
        merged.summary_source = null;
        stats.updated += 1;
      }

      byDoi.set(merged.doi, merged);
      if (merged.title_key) byTitle.set(merged.title_key, merged);
      continue;
    }

    // 同标题、不同 DOI：预印本与正式版视为同一篇
    const twin = rec.title_key ? byTitle.get(rec.title_key) : null;
    if (twin && twin.doi !== rec.doi && withinDays(twin, rec, 120)) {
      const upgrading = twin.is_preprint === true && rec.is_preprint === false;
      if (upgrading) {
        // 正式版取代预印本，但保留最初的发现时间
        const merged = {
          ...rec,
          first_seen: twin.first_seen,
          alt_doi: twin.doi,
          sources: [...new Set([...(twin.sources ?? []), ...(rec.sources ?? [])])],
          published: true,
          published_source: rec.published_source ?? twin.published_source ?? null,
        };
        byDoi.delete(twin.doi);
        byDoi.set(merged.doi, merged);
        byTitle.set(merged.title_key, merged);
      } else {
        twin.alt_doi = twin.alt_doi ?? rec.doi;
        twin.sources = [...new Set([...(twin.sources ?? []), ...(rec.sources ?? [])])];
        twin.published = twin.published === true || rec.published === true;
        twin.published_source = rec.published_source ?? twin.published_source ?? null;
        twin.last_updated = now;
      }
      stats.preprintMerged += 1;
      continue;
    }

    byDoi.set(rec.doi, rec);
    if (rec.title_key) byTitle.set(rec.title_key, rec);
    stats.added += 1;
  }

  const papers = [...byDoi.values()].sort((a, b) => {
    const d = String(b.sort_date ?? '').localeCompare(String(a.sort_date ?? ''));
    if (d !== 0) return d;
    return String(b.first_seen ?? '').localeCompare(String(a.first_seen ?? ''));
  });

  return { papers, stats };
}
