// src/llm.mjs
// DeepSeek 客户端。只在构建期运行，密钥永远不会进浏览器。
// 关键设计：LLM 结果按 (提示词版本, DOI, 摘要哈希) 缓存 —— 摘要没变就不重复花钱。

import {
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  DIRECTION_IDS,
  LLM_CONCURRENCY,
  LLM_MAX_RETRIES,
  LLM_MAX_TOKENS,
  LLM_TEMPERATURE,
} from './config.mjs';
import { PROMPT_VERSION, SYSTEM_PROMPT, buildUserPrompt } from './prompt.mjs';
import { sha256, sleep, truncate } from './util.mjs';

export function cacheKey(paper) {
  return sha256(`${PROMPT_VERSION}::${paper.doi}::${paper.abstract_hash ?? 'none'}`);
}

const asString = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** 容错解析：JSON 模式偶尔仍会包一层 markdown 代码块或前后缀文字 */
export function parseSummaryJson(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;

  const candidates = [raw];

  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidates.push(fenced[1].trim());

  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start !== -1 && end > start) candidates.push(raw.slice(start, end + 1));

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      // 试下一个候选
    }
  }
  return null;
}

/** 字段校验与归一化，防止模型给出越界的方向 id 或分数 */
export function normalizeSummary(obj) {
  if (!obj || typeof obj !== 'object') return null;

  const directions = Array.isArray(obj.directions)
    ? [...new Set(obj.directions.filter((d) => DIRECTION_IDS.includes(d)))]
    : [];

  const rawScore = Number(obj.novelty_score);
  const noveltyScore = Number.isFinite(rawScore)
    ? Math.min(5, Math.max(1, Math.round(rawScore)))
    : null;

  const keywords = Array.isArray(obj.keywords_zh)
    ? obj.keywords_zh.filter((k) => typeof k === 'string' && k.trim()).slice(0, 8)
    : [];

  return {
    title_zh: asString(obj.title_zh),
    innovation_zh: asString(obj.innovation_zh),
    method_zh: asString(obj.method_zh),
    directions,
    novelty_score: noveltyScore,
    novelty_reason: asString(obj.novelty_reason),
    keywords_zh: keywords,
  };
}

async function callDeepSeek({ apiKey, baseUrl, model, user }) {
  const url = `${String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '')}/chat/completions`;
  let lastErr;

  for (let attempt = 0; attempt <= LLM_MAX_RETRIES; attempt += 1) {
    if (attempt > 0) await sleep(Math.min(1000 * 2 ** (attempt - 1), 8000));

    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: model || DEFAULT_MODEL,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: user },
          ],
          response_format: { type: 'json_object' },
          temperature: LLM_TEMPERATURE,
          max_tokens: LLM_MAX_TOKENS,
        }),
        signal: AbortSignal.timeout(120000),
      });
    } catch (err) {
      lastErr = err; // 网络层错误，重试
      continue;
    }

    if (res.status === 429 || res.status >= 500) {
      lastErr = new Error(`HTTP ${res.status}`);
      continue;
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const err = new Error(`DeepSeek HTTP ${res.status}: ${body.slice(0, 200)}`);
      err.permanent = true;
      throw err;
    }

    const data = await res.json().catch(() => null);
    const content = data?.choices?.[0]?.message?.content ?? '';
    const summary = normalizeSummary(parseSummaryJson(content));

    if (!summary || !summary.innovation_zh) {
      lastErr = new Error('返回内容无法解析为有效 JSON');
      continue;
    }
    return summary;
  }

  throw new Error(`DeepSeek 调用失败：${lastErr?.message ?? '未知错误'}`);
}

/** 有并发上限的任务池 */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;

  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  });

  await Promise.all(workers);
  return results;
}

export function applySummary(paper, summary, model) {
  paper.title_zh = summary.title_zh ?? paper.title_zh ?? null;
  paper.innovation_zh = summary.innovation_zh;
  paper.method_zh = summary.method_zh ?? null;
  paper.novelty_score = summary.novelty_score ?? null;
  paper.novelty_reason = summary.novelty_reason ?? null;
  paper.keywords_zh = summary.keywords_zh ?? [];
  paper.directions = [...new Set([...(paper.directions ?? []), ...(summary.directions ?? [])])];
  if (paper.directions.length === 0) paper.directions = ['materials'];
  paper.summary_source = 'llm';
  paper.llm_model = model || DEFAULT_MODEL;
  paper.llm_at = new Date().toISOString();
  paper.pending_summary = false;
  return paper;
}

/**
 * 批量生成中文总结。
 * @param {object[]} papers 会被就地修改
 * @param {{apiKey?: string, baseUrl?: string, model?: string, cache?: object, concurrency?: number, log?: Function}} opts
 */
export async function summarizePapers(papers, opts = {}) {
  const {
    apiKey = process.env.DEEPSEEK_API_KEY,
    baseUrl = process.env.DEEPSEEK_BASE_URL || DEFAULT_BASE_URL,
    model = process.env.DEEPSEEK_MODEL || DEFAULT_MODEL,
    cache = {},
    concurrency = LLM_CONCURRENCY,
    log = console.log,
  } = opts;

  const stats = { pending: 0, fromCache: 0, generated: 0, failed: 0 };

  if (!apiKey) {
    stats.pending = papers.filter((p) => p.pending_summary).length;
    return { stats, skippedReason: 'no-api-key' };
  }

  const targets = papers.filter((p) => p.pending_summary);
  stats.pending = targets.length;
  if (targets.length === 0) return { stats, skippedReason: null };

  log(`   需要生成中文总结：${targets.length} 篇（并发 ${concurrency}）`);

  await mapLimit(targets, concurrency, async (paper) => {
    const key = cacheKey(paper);

    const hit = cache[key];
    if (hit?.summary?.innovation_zh) {
      applySummary(paper, hit.summary, hit.model ?? model);
      stats.fromCache += 1;
      return;
    }

    try {
      const summary = await callDeepSeek({
        apiKey,
        baseUrl,
        model,
        user: buildUserPrompt(paper, { abstract: truncate(paper.abstract, 3000) }),
      });
      applySummary(paper, summary, model);
      cache[key] = { at: new Date().toISOString(), model, summary };
      stats.generated += 1;
    } catch (err) {
      // 单篇失败不影响整轮；下一轮会因为是 pending 而自动重试
      paper.pending_summary = true;
      paper.summary_source = 'failed';
      stats.failed += 1;
      log(`   ⚠ 总结失败 [${paper.doi}]：${err.message}`);
    }
  });

  return { stats, skippedReason: null };
}
