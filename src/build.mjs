// src/build.mjs —— 唯一入口：抓取 → 过滤 → 补摘要 → 合并 → LLM 中文总结 → 渲染站点
//
// 用法：
//   node src/build.mjs                     默认窗口（DEFAULT_WINDOW_DAYS 天）
//   node src/build.mjs --days=90           回填 90 天
//   node src/build.mjs --days=30 --dry-run 只报告，不写任何文件、不调 LLM
//   node src/build.mjs --no-llm            只抓取建站，跳过 DeepSeek
//   node src/build.mjs --llm-limit=10      本轮最多只生成 10 篇中文总结（先花小钱看质量）

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_WINDOW_DAYS,
  MAX_WINDOW_DAYS,
  PROJECT_NAME,
} from './config.mjs';
import { fetchCrossrefAbstract } from './crossref.mjs';
import { loadEnv } from './env.mjs';
import { summarizePapers } from './llm.mjs';
import { fetchWorks } from './openalex.mjs';
import { evaluateRelevance, isPreprint } from './relevance.mjs';
import { renderSite } from './render.mjs';
import { loadJson, makeRecord, mergeRecords, saveJsonAtomic } from './store.mjs';
import { daysBefore } from './util.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCS_DIR = path.join(ROOT, 'docs');
const PAPERS_FILE = path.join(DOCS_DIR, 'data', 'papers.json');
/** 中文总结缓存：即使本轮没跑完，已付费的总结也不会白花（不进仓库、不上线） */
const CACHE_FILE = path.join(ROOT, '.cache', 'llm-cache.json');

/** 单轮最多向 Crossref 补查多少次摘要，避免把对方 API 打爆 */
const MAX_CROSSREF_LOOKUPS = 60;

function parseArgs(argv) {
  const args = { days: null, since: null, dryRun: false, noLlm: false, limit: 0, llmLimit: 0, quiet: false };

  for (const token of argv) {
    if (token === '--dry-run') args.dryRun = true;
    else if (token === '--no-llm') args.noLlm = true;
    else if (token === '--quiet') args.quiet = true;
    else if (token.startsWith('--days=')) args.days = Number(token.slice(7));
    else if (token.startsWith('--since=')) args.since = token.slice(8);
    else if (token.startsWith('--limit=')) args.limit = Number(token.slice(8));
    else if (token.startsWith('--llm-limit=')) args.llmLimit = Number(token.slice(12));
    else throw new Error(`未知参数：${token}`);
  }

  if (args.days == null) args.days = DEFAULT_WINDOW_DAYS;
  if (!Number.isFinite(args.days) || args.days <= 0) throw new Error('--days 必须是正整数');
  if (args.days > MAX_WINDOW_DAYS) {
    throw new Error(`--days 最大 ${MAX_WINDOW_DAYS}（再往前 OpenAlex 单轮翻页拿不全）`);
  }
  return args;
}

function formatClock() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

async function main() {
  const started = Date.now();
  const args = parseArgs(process.argv.slice(2));
  loadEnv();

  const log = args.quiet ? () => {} : (...parts) => console.log(...parts);
  const now = new Date().toISOString();
  const fromDate = args.since || daysBefore(args.days, new Date());

  console.log(`\n=== ${PROJECT_NAME} · 构建开始 · ${formatClock()} ===`);
  console.log(`   抓取窗口：${fromDate} → 今天（${args.since ? '--since 指定' : `${args.days} 天`}）`);
  if (args.dryRun) console.log('   模式：dry-run（不写文件、不调用 DeepSeek）');

  // ---------- 1. 读取现有账本 ----------
  const store = await loadJson(PAPERS_FILE, { papers: [] });
  const existing = Array.isArray(store?.papers) ? store.papers : [];
  console.log(`   现有账本：${existing.length} 篇`);

  // ---------- 2. 抓取 ----------
  const { works, total } = await fetchWorks({ fromDate, log });
  console.log(`   OpenAlex 命中 ${works.length} 篇（约 ${total} 篇，已按 DOI 收发）`);

  // ---------- 3. 相关性过滤 + 摘要补齐 ----------
  const rejectStats = new Map();
  const accepted = [];
  let crossrefLookups = 0;
  let crossrefFilled = 0;

  // 上一轮已经查过 Crossref 但对方确实没有摘要的论文：不要每天重复查一遍
  const alreadyTried = new Set(existing.filter((p) => p.abstract_missing).map((p) => p.doi));

  for (const raw of works) {
    if (args.limit && accepted.length >= args.limit) break;

    let relevance = evaluateRelevance(raw);

    // 没有摘要、但标题里已经有量子点证据 → 值得花一次 Crossref 查询
    if (
      !raw.abstract &&
      relevance.detail.qdHits.length > 0 &&
      !alreadyTried.has(raw.doi) &&
      crossrefLookups < MAX_CROSSREF_LOOKUPS
    ) {
      crossrefLookups += 1;
      const fetched = await fetchCrossrefAbstract(raw.doi);
      if (fetched) {
        raw.abstract = fetched;
        raw.abstract_source = 'crossref';
        crossrefFilled += 1;
        relevance = evaluateRelevance(raw);
      }
    }

    if (!relevance.pass) {
      rejectStats.set(relevance.reason, (rejectStats.get(relevance.reason) ?? 0) + 1);
      continue;
    }

    if (!raw.abstract) raw.abstract_source = 'none';
    accepted.push({ raw, relevance });
  }

  const dropped = [...rejectStats.entries()].sort((a, b) => b[1] - a[1]);
  console.log(`   相关性过滤：保留 ${accepted.length} 篇，丢弃 ${works.length - accepted.length} 篇`);
  for (const [reason, count] of dropped) console.log(`      - ${reason}：${count}`);
  if (crossrefLookups) console.log(`   Crossref 补摘要：查询 ${crossrefLookups} 次，命中 ${crossrefFilled} 篇`);

  // ---------- 4. 构造记录并合并 ----------
  const incoming = accepted.map(({ raw, relevance }) =>
    makeRecord(raw, {
      now,
      directions: relevance.directions,
      isPreprint: isPreprint(raw),
    }),
  );

  const { papers, stats } = mergeRecords(existing, incoming, { now });
  console.log(
    `   合并：新增 ${stats.added}、摘要变更 ${stats.updated}、无变化 ${stats.unchanged}、预印本归并 ${stats.preprintMerged}`,
  );

  // ---------- 5. 中文总结 ----------
  let llmReport = { stats: { pending: 0, generated: 0, fromCache: 0, failed: 0 }, skippedReason: 'dry-run' };
  if (!args.dryRun && !args.noLlm) {
    // 缓存落盘（每 5 秒 + 结束时）：额度耗尽或中途中断，已付费的总结不会丢
    await fs.mkdir(path.dirname(CACHE_FILE), { recursive: true });
    const cache = await loadJson(CACHE_FILE, {});
    let saving = false;
    const flush = async () => {
      if (saving) return;
      saving = true;
      try {
        await saveJsonAtomic(CACHE_FILE, cache);
      } finally {
        saving = false;
      }
    };
    const timer = setInterval(() => { void flush(); }, 5000);

    try {
      const waiting = papers.filter((p) => p.pending_summary);
      const targets = args.llmLimit > 0 ? waiting.slice(0, args.llmLimit) : papers;
      if (args.llmLimit > 0) {
        console.log(`   LLM：本轮只处理 ${Math.min(args.llmLimit, waiting.length)}/${waiting.length} 篇（--llm-limit）`);
      }
      llmReport = await summarizePapers(targets, { log: (msg) => log(msg), cache });
    } finally {
      clearInterval(timer);
      await flush();
    }

    const s = llmReport.stats;
    if (llmReport.skippedReason === 'no-api-key') {
      console.log('   LLM：未配置 DEEPSEEK_API_KEY，跳过中文总结（论文仍会入库）');
    } else {
      console.log(`   LLM：生成 ${s.generated}、复用缓存 ${s.fromCache}、失败 ${s.failed}、待处理 ${s.pending}`);
    }
  } else if (args.noLlm) {
    console.log('   LLM：--no-llm，跳过中文总结');
  }

  // ---------- 6. 落盘 ----------
  const meta = {
    generated_at: now,
    window_days: args.since ? null : args.days,
    from_date: fromDate,
    summary_engine: llmReport.skippedReason ? null : (process.env.DEEPSEEK_MODEL || 'deepseek-chat'),
    stats: {
      fetched: works.length,
      kept: accepted.length,
      added: stats.added,
      updated: stats.updated,
      unchanged: stats.unchanged,
      preprint_merged: stats.preprintMerged,
      llm_generated: llmReport.stats.generated,
      llm_failed: llmReport.stats.failed,
      pending_summary: papers.filter((p) => p.pending_summary).length,
    },
  };

  if (args.dryRun) {
    console.log('   dry-run：未写入任何文件。');
    const preview = papers.slice(0, 5).map((p) => `      · ${p.pub_date} | ${p.venue ?? '?'} | ${String(p.title ?? '').slice(0, 70)}`);
    if (preview.length) console.log(`   预览前 ${preview.length} 篇：\n${preview.join('\n')}`);
  } else {
    await saveJsonAtomic(PAPERS_FILE, { generated_at: now, count: papers.length, papers });
    await renderSite({ papers, meta, outDir: DOCS_DIR, log });
  }

  console.log(`   耗时 ${((Date.now() - started) / 1000).toFixed(1)}s\n`);
}

main().catch((err) => {
  console.error(`\n✗ 构建失败：${err?.stack || err}\n`);
  process.exit(1);
});
