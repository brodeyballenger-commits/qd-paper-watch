// src/crossref.mjs
// 摘要兜底源。实测：Crossref 对 Elsevier/ACS 等出版商常常没有 abstract 字段，
// 所以只作为 OpenAlex 倒排索引缺失时的补充，命中率不高但几乎零成本。

import { CROSSREF_DELAY_MS } from './config.mjs';
import { normalizeCrossrefAbstract } from './abstract.mjs';
import { fetchWithRetry } from './http.mjs';
import { sleep } from './util.mjs';

let lastCall = 0;

/** Crossref 要求更保守的速率 */
async function throttle() {
  const wait = CROSSREF_DELAY_MS - (Date.now() - lastCall);
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();
}

/**
 * @param {string} doi 规范化的裸 DOI
 * @returns {Promise<string|null>} 摘要文本，取不到返回 null（不抛错）
 */
export async function fetchCrossrefAbstract(doi) {
  if (!doi) return null;

  await throttle();

  const params = new URLSearchParams({ select: 'DOI,abstract,title' });
  if (process.env.CONTACT_EMAIL) params.set('mailto', process.env.CONTACT_EMAIL);

  const url = `https://api.crossref.org/works/${encodeURIComponent(doi)}?${params.toString()}`;

  try {
    const data = await fetchWithRetry(url, {
      label: `Crossref ${doi}`,
      retries: 1,
    });
    return normalizeCrossrefAbstract(data?.message?.abstract);
  } catch {
    // 404（DOI 未收录）或其它错误都不应影响整轮抓取
    return null;
  }
}
