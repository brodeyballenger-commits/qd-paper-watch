// src/build.mjs —— 唯一入口：多源抓取 → 见刊闸门 → 过滤 → 补摘要 → 合并 → LLM 中文总结 → 渲染站点
//
// 用法：
//   node src/build.mjs                     默认窗口（DEFAULT_WINDOW_DAYS 天）
//   node src/build.mjs --days=90           回填 90 天
//   node src/build.mjs --days=30 --dry-run 只报告，不写任何文件、不调 LLM
//   node src/build.mjs --no-llm            只抓取建站，跳过 DeepSeek
//   node src/build.mjs --llm-limit=10      本轮最多只生成 10 篇中文总结（先花小钱看质量）
//   node src/build.mjs --sources=openalex,crossref   只启用指定数据源
//   node src/build.mjs --include-preprints           连预印本一起收（默认只收已见刊）

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_WINDOW_DAYS,
  MAX_WINDOW_DAYS,
  PROJECT_NAME,
  SOURCE_LABELS,
} from './config.mjs';
import { backfillAbstracts } from './abstract-backfill.mjs';
import { loadEnv } from './env.mjs';
import { summarizePapers } from './llm.mjs';
import { applyPublishedFieldsToLedger, applyPublishedGate, isPublishedWork } from './published.mjs';
import { evaluateRelevance, isPreprint, isQledDevice } from './relevance.mjs';
import { renderSite } from './render.mjs';
import { dedupeCandidates, fetchAllSources, resolveSources } from './sources.mjs';
import { loadJson, makeRecord, mergeRecords, saveJsonAtomic } from './store.mjs';
import { daysBefore } from './util.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCS_DIR = path.join(ROOT, 'docs');
const PAPERS_FILE = path.join(DOCS_DIR, 'data', 'papers.json');
/** 中文总结缓存：即使本轮没跑完，已付费的总结也不会白花（不进仓库、不上线） */
const CACHE_FILE = path.join(ROOT, '.cache', 'llm-cache.json');

function parseArgs(argv) {
  const args = {
    days: null,
    since: null,
    dryRun: false,
    noLlm: false,
    limit: 0,
    llmLimit: 0,
    quiet: false,
    sources: null,
    includePreprints: false,
  };

  for (const token of argv) {
    if (token === '--dry-run') args.dryRun = true;
    else if (token === '--no-llm') args.noLlm = true;
    else if (token === '--quiet') args.quiet = true;
    else if (token === '--include-preprints') args.includePreprints = true;
    else if (token.startsWith('--days=')) args.days = Number(token.slice(7));
    else if (token.startsWith('--since=')) args.since = token.slice(8);
    else if (token.startsWith('--limit=')) args.limit = Number(token.slice(8));
    else if (token.startsWith('--llm-limit=')) args.llmLimit = Number(token.slice(12));
    else if (token.startsWith('--sources=')) args.sources = token.slice(10);
    else throw new Error(`未知参数：${token}`);
  }

  if (args.days == null) args.days = DEFAULT_WINDOW_DAYS;
  if (!Number.isFinite(args.days) || args.days <= 0) throw new Error('--days 必须是正整数');
  if (args.days > MAX_WINDOW_DAYS) {
    throw new Error(`--days 最大 ${MAX_WINDOW_DAYS}（再往前 OpenAlex 单轮翻页拿不全）`);
  }
  // 未知源名在这里就报错，不要等抓到一半才发现
  args.sourceIds = resolveSources(args.sources);
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

  // ---------- 2. 多源抓取 + 去重 ----------
  const sourceLabels = args.sourceIds.map((id) => SOURCE_LABELS[id] ?? id).join('、');
  console.log(`   数据源：${sourceLabels}`);
  const { works, report } = await fetchAllSources({ fromDate, log, sources: args.sourceIds });
  const candidates = dedupeCandidates(works);
  console.log(`   多源合并去重：${works.length} → ${candidates.length} 篇`);

  // ---------- 2.6 见刊闸门：只留已经有正式期刊版本的论文 ----------
  let screened = candidates;
  const publishedStats = new Map();
  if (args.includePreprints) {
    // 连预印本一起收，但仍如实标注它是不是见刊版本
    for (const raw of candidates) {
      const verdict = isPublishedWork(raw);
      raw.published = verdict.published;
      raw.published_source = verdict.published_source;
    }
    console.log('   见刊闸门：--include-preprints，预印本也保留（会标注「预印本」）');
  } else {
    const gate = applyPublishedGate(candidates);
    screened = gate.published;
    for (const [reason, count] of [...gate.stats.entries()].sort((a, b) => b[1] - a[1])) {
      publishedStats.set(reason, count);
    }
    console.log(`   见刊闸门：已见刊 ${gate.published.length} 篇，丢弃 ${gate.dropped} 篇`);
    for (const [reason, count] of publishedStats) console.log(`      - ${reason}：${count}`);
  }

  // ---------- 2.8 摘要兜底（批量） ----------
  // 多源合并后仍有相当一部分论文没有摘要（Crossref 常不给 abstract），
  // 而没有摘要就只能写「数据库未收录摘要」并且创新度只能给 1★。
  // 这里在进入相关性判定之前，用两个批量接口一次性补齐（每轮只需几次请求）。
  await backfillAbstracts(screened, { log });

  // ---------- 3. 相关性过滤 ----------
  // 摘要已经在 2.8 用批量接口补过一轮，这里不再逐篇查 Crossref：
  // 实测逐篇查 60 次 0 命中（Crossref 对这些出版商根本没有 abstract），纯浪费时间和配额。
  const rejectStats = new Map();
  const accepted = [];

  for (const raw of screened) {
    if (args.limit && accepted.length >= args.limit) break;

    const relevance = evaluateRelevance(raw);

    if (!relevance.pass) {
      rejectStats.set(relevance.reason, (rejectStats.get(relevance.reason) ?? 0) + 1);
      continue;
    }

    if (!raw.abstract) raw.abstract_source = 'none';
    accepted.push({ raw, relevance });
  }

  const dropped = [...rejectStats.entries()].sort((a, b) => b[1] - a[1]);
  console.log(`   相关性过滤：保留 ${accepted.length} 篇，丢弃 ${screened.length - accepted.length} 篇`);
  for (const [reason, count] of dropped) console.log(`      - ${reason}：${count}`);

  // ---------- 4. 构造记录并合并 ----------
  const incoming = accepted.map(({ raw, relevance }) =>
    makeRecord(raw, {
      now,
      directions: relevance.directions,
      // 已判定为见刊的就不该再打预印本标记；--include-preprints 时仍按源字段判断
      isPreprint: raw.published === false ? true : isPreprint(raw),
    }),
  );

  const { papers, stats } = mergeRecords(existing, incoming, { now });
  console.log(
    `   合并：新增 ${stats.added}、摘要变更 ${stats.updated}、无变化 ${stats.unchanged}、预印本归并 ${stats.preprintMerged}`,
  );

  // 存量自愈：老记录（多源改造之前）补 sources / published，幂等
  const healed = applyPublishedFieldsToLedger(papers);
  if (healed) console.log(`   存量补标：${healed} 篇补上来源/见刊字段`);
  const publishedTotal = papers.filter((p) => p.published === true).length;

  // ---------- 4.5 主方向标签：量子点发光二极管（QD-LED） ----------
  // 纯规则、幂等、只增不减：存量论文（早于本次词表）也会被补上标签，
  // 所以站点的「只看量子点发光二极管」对老数据一样有效。
  let qledTagged = 0;
  for (const p of papers) {
    if (!isQledDevice(p)) continue;
    if (!Array.isArray(p.directions)) p.directions = [];
    if (p.directions.includes('qled')) continue;
    p.directions.push('qled');
    qledTagged += 1;
  }
  const qledTotal = papers.filter((p) => (p.directions ?? []).includes('qled')).length;
  console.log(`   主方向（量子点发光二极管）：${qledTotal} 篇${qledTagged ? `（本次补标 ${qledTagged} 篇）` : ''}`);

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
      console.log(`   LLM：本轮待生成 ${s.pending}、生成 ${s.generated}、复用缓存 ${s.fromCache}、失败 ${s.failed}、仍未生成 ${s.stillPending ?? s.pending}`);
    }
  } else if (args.noLlm) {
    console.log('   LLM：--no-llm，跳过中文总结');
  }

  // LLM 也会自己补 qled 方向标签（applySummary 是并集），所以主方向数量以最终账本为准重算一次
  const qledFinal = papers.filter((p) => (p.directions ?? []).includes('qled')).length;
  if (qledFinal !== qledTotal) {
    console.log(`   主方向（量子点发光二极管）：${qledFinal} 篇（含 LLM 补标 ${qledFinal - qledTotal} 篇）`);
  }

  // ---------- 6. 落盘 ----------
  const meta = {
    generated_at: now,
    window_days: args.since ? null : args.days,
    from_date: fromDate,
    summary_engine: llmReport.skippedReason ? null : (process.env.DEEPSEEK_MODEL || 'deepseek-chat'),
    source: args.sourceIds.map((id) => SOURCE_LABELS[id] ?? id).join(' + '),
    sources: args.sourceIds,
    source_stats: report,
    include_preprints: args.includePreprints,
    stats: {
      fetched: works.length,
      deduped: candidates.length,
      published: publishedTotal,
      published_dropped: args.includePreprints ? 0 : candidates.length - screened.length,
      kept: accepted.length,
      added: stats.added,
      updated: stats.updated,
      unchanged: stats.unchanged,
      preprint_merged: stats.preprintMerged,
      llm_generated: llmReport.stats.generated,
      llm_failed: llmReport.stats.failed,
      pending_summary: papers.filter((p) => p.pending_summary).length,
      qled_focus: qledFinal,
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
