// src/http.mjs
// 统一的带重试请求。Node 原生 fetch。
// 说明：本项目所有网络请求都必须走 Node —— 本机 PowerShell 的 schannel 被沙箱限制，
// Invoke-WebRequest / curl.exe 会直接失败（SEC_E_NO_CREDENTIALS）。

import { MAX_RETRIES, TIMEOUT_MS } from './config.mjs';
import { sleep } from './util.mjs';

const CONTACT = process.env.CONTACT_EMAIL || 'qd-paper-watch@users.noreply.github.com';

export const USER_AGENT = `QD-Paper-Watch/0.1 (mailto:${CONTACT})`;

const backoffMs = (attempt) =>
  Math.min(1000 * 2 ** (attempt - 1), 8000) + Math.floor(Math.random() * 250);

/**
 * 带指数退避重试的请求。
 * - 429 / 5xx / 网络层错误 -> 重试
 * - 其它 4xx -> 立刻抛出（重试没有意义）
 *
 * @returns {Promise<any>} expectJson 为 true 时返回解析后的 JSON，否则返回文本
 */
export async function fetchWithRetry(url, opts = {}) {
  const {
    retries = MAX_RETRIES,
    headers = {},
    label = url,
    expectJson = true,
    timeoutMs = TIMEOUT_MS,
  } = opts;

  let lastErr;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (attempt > 0) {
      const wait = backoffMs(attempt);
      console.warn(`      ↻ 重试 ${attempt}/${retries}（${wait}ms 后）：${label}`);
      await sleep(wait);
    }

    let res;
    try {
      res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', ...headers },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      // 网络层错误（DNS / TLS / 超时 / 连接重置）—— 可重试
      lastErr = err;
      continue;
    }

    if (res.ok) {
      return expectJson ? res.json() : res.text();
    }

    const body = await res.text().catch(() => '');
    const snippet = body.replace(/\s+/g, ' ').slice(0, 220);

    if (res.status === 429 || res.status >= 500) {
      lastErr = new Error(`HTTP ${res.status} :: ${snippet}`);
      continue;
    }

    throw new Error(`HTTP ${res.status}（不可重试）：${label} :: ${snippet}`);
  }

  throw new Error(
    `请求失败：${label}。已重试 ${retries} 次，最后一次错误：${lastErr?.message ?? '未知'}`,
  );
}
