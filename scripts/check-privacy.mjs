#!/usr/bin/env node
/**
 * 隐私自检：把「密钥与个人信息不上公开仓库」变成一条可执行的检查。
 *
 * 用法：
 *   node scripts/check-privacy.mjs             # 扫当前工作区（含还没提交的新文件）
 *   node scripts/check-privacy.mjs --history   # 再扫一遍 git 历史里出现过的所有内容
 *
 * 结果：
 *   - 命中：打印「文件:行:列 [规则] 说明 命中=xx***」并以退出码 1 结束，
 *           CI 会因此拒绝这次更新；命中内容只留前两个字符或域名，
 *           避免把要防的东西写进公开的 CI 日志。
 *   - 通过：退出码 0。
 *
 * 不扫 docs/：整个目录都是 src/site 与公开论文数据生成出来的，
 * 源文件与数据生成逻辑本身都在扫描范围内。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scanText } from '../src/privacy.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['.git', 'node_modules', '.cache', '.tmp', 'docs']);
const SKIP_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.svgz',
  '.pdf', '.zip', '.gz', '.7z', '.woff', '.woff2', '.ttf', '.eot',
  '.mp3', '.mp4', '.mov', '.xlsx', '.docx', '.pptx',
]);
const MAX_BYTES = 2 * 1024 * 1024;

const rel = (abs) => path.relative(ROOT, abs).split(path.sep).join('/');

/**
 * 本机私密文件：正常情况永远不会被提交（`.gitignore` 里盯着），
 * 所以扫工作区时跳过它们 —— 否则你自己的 `.env` 会让自检永远失败。
 * 注意：**历史检查不跳过** `.env`：真要有哪个版本的 `.env` 进过仓库，那是必须立刻处理的泄露。
 */
function isLocalSecret(abs) {
  const name = path.basename(abs);
  return /^\.env(\.|$)/.test(name) && name !== '.env.example';
}

function skippedPath(p) {
  const parts = String(p).split('/');
  if (parts.some((seg) => SKIP_DIRS.has(seg))) return true;
  return SKIP_EXT.has(path.extname(p).toLowerCase());
}

async function walk(dir, out = []) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await walk(path.join(dir, entry.name), out);
    } else if (entry.isFile()) {
      if (SKIP_EXT.has(path.extname(entry.name).toLowerCase())) continue;
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

async function scanWorkspace() {
  const found = (await walk(ROOT)).sort();
  const skipped = [];
  const files = [];

  for (const abs of found) {
    if (isLocalSecret(abs)) {
      skipped.push(`${rel(abs)}（本机私密文件，不会被提交）`);
      continue;
    }
    files.push(abs);
  }

  const findings = [];

  for (const abs of files) {
    const stat = await fs.stat(abs);
    if (stat.size > MAX_BYTES) {
      skipped.push(`${rel(abs)}（${Math.round(stat.size / 1024)}KB，超过 ${MAX_BYTES / 1024 / 1024}MB 上限）`);
      continue;
    }
    const buf = await fs.readFile(abs);
    if (buf.includes(0)) continue; // 二进制
    findings.push(...scanText(buf.toString('utf8'), { id: rel(abs) }));
  }

  return { files, findings, skipped };
}

function gitLogPatch() {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['log', '-p', '--all', '--no-color', '--no-show-signature', '--date=short', '--format=%n=== 提交 %H %ad %s'],
      { cwd: ROOT, maxBuffer: 512 * 1024 * 1024, encoding: 'utf8', windowsHide: true },
      (err, stdout) => {
        if (err && /does not have any commits yet|unknown revision/i.test(String(err.message))) return resolve('');
        return err ? reject(err) : resolve(stdout);
      },
    );
  });
}

async function scanHistory() {
  const patch = await gitLogPatch();
  if (!patch.trim()) return [];

  const findings = [];
  const parts = patch.split(/^diff --git /m);

  // 第一段是各次提交的元信息（提交信息里也可能夹带隐私）
  findings.push(...scanText(parts[0], { id: '历史:提交信息' }));

  for (const part of parts.slice(1)) {
    const m = part.match(/^a\/([^\s]+) /);
    const file = m ? m[1] : '(未知文件)';
    if (skippedPath(file)) continue;
    findings.push(...scanText(part, { id: `历史:${file}` }));
  }

  return findings;
}

const wantHistory = process.argv.slice(2).includes('--history');
const { files, findings: workspaceFindings, skipped } = await scanWorkspace();

let findings = workspaceFindings;
if (wantHistory) {
  try {
    findings = findings.concat(await scanHistory());
  } catch (err) {
    console.error(`✗ 历史检查失败（需要完整的 git 历史，CI 里请用 fetch-depth: 0）：${err.message}`);
    process.exit(1);
  }
}

console.log(`隐私自检：扫了 ${files.length} 个工作区文件${wantHistory ? '，以及 git 历史里的全部改动' : ''}。`);
for (const s of skipped) console.log(`  · 跳过 ${s}`);

if (findings.length === 0) {
  console.log('✓ 没有发现密钥或个人信息。');
  process.exit(0);
}

console.error(`✗ 发现 ${findings.length} 处疑似泄露：`);
for (const f of findings.slice(0, 100)) {
  console.error(`  ${f.file}:${f.line}:${f.column} [${f.rule}] ${f.hint} 命中=${f.masked}`);
}
if (findings.length > 100) console.error(`  …还有 ${findings.length - 100} 处`);

console.error('如果确认是误报，请把对应域名/模式加进 src/privacy.mjs 的白名单，而不是绕开这个检查。');
process.exit(1);
