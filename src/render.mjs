// src/render.mjs
// 把主账本渲染成可直接发布的静态站点（docs/）。
// 站点源码是唯一真源：src/site/*，这里只做拷贝 + 内联生成 standalone.html。

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DIRECTIONS, HIGH_NOVELTY_THRESHOLD, PROJECT_NAME } from './config.mjs';
import { applyJournalMetrics, CAS_TIER_YEAR, JCR_YEAR, MUST_READ, nonResearchReason } from './journal-metrics.mjs';
import { writeFileAtomic } from './util.mjs';

const SITE_SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'site');

/** 内联进 <script> 的 JSON 必须转义 "<"，否则正文里出现 </script> 会截断脚本 */
function safeJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

async function readSiteFile(name) {
  return fs.readFile(path.join(SITE_SRC, name), 'utf8');
}

/**
 * @param {object} opts
 * @param {object[]} opts.papers
 * @param {object} opts.meta
 * @param {string} opts.outDir docs 目录绝对路径
 */
export async function renderSite({ papers, meta, outDir, log = console.log }) {
  const assetsDir = path.join(outDir, 'assets');
  const dataDir = path.join(outDir, 'data');
  await fs.mkdir(assetsDir, { recursive: true });
  await fs.mkdir(dataDir, { recursive: true });

  const [html, appJs, css] = await Promise.all([
    readSiteFile('index.html'),
    readSiteFile('app.js'),
    readSiteFile('style.css'),
  ]);

  // 账本可能来自旧版本的构建脚本（例如 GitHub Actions 用旧代码生成的
  // docs/data/papers.json），里面没有 journal_if / journal_tier，也没有剔除
  // Nature 的 News & Views 这类非研究性条目。这里补做一次，幂等：
  // 期刊指标只依赖刊名；非研究性判定只依赖标题 + 一小份手工 DOI 名单。
  const researchPapers = papers.filter((p) => !nonResearchReason(p));
  const pruned = papers.length - researchPapers.length;
  if (pruned > 0) {
    papers.length = 0;
    papers.push(...researchPapers);
    log(`   剔除非研究性条目：${pruned} 篇（评论/社论/勘误等）`);
  }
  applyJournalMetrics(papers);

  const fullMeta = {
    project: PROJECT_NAME,
    generated_at: meta.generated_at ?? new Date().toISOString(),
    count: papers.length,
    window_days: meta.window_days ?? null,
    // 只下发前端用得到的字段：配色在设计系统里，不在数据里。
    directions: DIRECTIONS.map(({ id, label }) => ({ id, label })),
    highNoveltyThreshold: HIGH_NOVELTY_THRESHOLD,
    stats: meta.stats ?? {},
    source: meta.source ?? 'OpenAlex',
    sources: meta.sources ?? ['openalex'],
    source_stats: meta.source_stats ?? [],
    include_preprints: meta.include_preprints === true,
    published_count: papers.filter((p) => p.published === true).length,
    preprint_count: papers.filter((p) => p.published === false).length,
    summary_engine: meta.summary_engine ?? null,
    // 「必读栏」的筛选规则随数据一起发布，前端只读不算：
    // 改门槛只改 src/journal-metrics.mjs，不用重新抓取，重建一次站点即可。
    must_read: {
      ...MUST_READ,
      jcr_year: JCR_YEAR,
      cas_tier_year: CAS_TIER_YEAR,
    },
  };

  // 1) GitHub Pages 版（外链资源）
  await fs.writeFile(path.join(outDir, 'index.html'), html, 'utf8');
  await fs.writeFile(path.join(assetsDir, 'app.js'), appJs, 'utf8');
  await fs.writeFile(path.join(assetsDir, 'style.css'), css, 'utf8');
  await writeFileAtomic(fs, path.join(dataDir, 'papers.json'), `${JSON.stringify({ generated_at: fullMeta.generated_at, count: papers.length, papers }, null, 2)}\n`);
  await writeFileAtomic(fs, path.join(dataDir, 'meta.json'), `${JSON.stringify(fullMeta, null, 2)}\n`);
  await fs.writeFile(path.join(outDir, '.nojekyll'), '', 'utf8');

  // 2) 单文件版（无网络依赖，方便发微信、离线打开、国内访问 Pages 不稳时兜底）
  const standalone = html
    .replace(
      '<link rel="stylesheet" href="assets/style.css">',
      `<style>\n${css}\n</style>`,
    )
    .replace(
      '<script src="assets/app.js"></script>',
      `<script>window.__PAPERS__ = ${safeJson(papers)};\nwindow.__META__ = ${safeJson(fullMeta)};</script>\n<script>\n${appJs}\n</script>`,
    );

  await writeFileAtomic(fs, path.join(outDir, 'standalone.html'), standalone);

  log(`   站点已生成：${papers.length} 篇 → docs/index.html、docs/standalone.html`);
  return { meta: fullMeta };
}
