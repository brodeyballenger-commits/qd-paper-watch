// src/abstract.mjs
// OpenAlex 的摘要是「倒排索引」：每个词 -> 出现位置数组。
// 必须按 position 升序拼回去才能还原词序，这是最容易写错的一步，已有单测覆盖。

import { stripMarkup } from './util.mjs';

/**
 * @param {Record<string, number[]>|null|undefined} invertedIndex
 * @returns {string|null} 还原后的摘要；无法还原时返回 null
 */
export function restoreAbstract(invertedIndex) {
  if (!invertedIndex || typeof invertedIndex !== 'object') return null;

  /** @type {Array<[number, string]>} */
  const slots = [];

  for (const [word, positions] of Object.entries(invertedIndex)) {
    if (!Array.isArray(positions)) continue;
    const w = String(word);
    for (const p of positions) {
      if (Number.isInteger(p) && p >= 0) slots.push([p, w]);
    }
  }

  if (slots.length === 0) return null;

  // 同一位置重复出现时保持稳定；按位置升序即为原词序
  slots.sort((a, b) => a[0] - b[0]);

  const text = slots.map(([, w]) => w).join(' ');
  return stripMarkup(text).replace(/\s+/g, ' ').trim() || null;
}

/**
 * Crossref 的摘要是 JATS XML 片段（<jats:p>…</jats:p>），需要去标签。
 * @returns {string|null}
 */
export function normalizeCrossrefAbstract(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const text = stripMarkup(raw)
    // JATS 摘要常以 "Abstract" 标题开头，去掉它
    .replace(/^\s*abstract[:\s]*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length >= 40 ? text : null;
}
