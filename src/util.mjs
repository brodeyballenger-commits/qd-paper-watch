// src/util.mjs
// 无依赖的小工具。

import { createHash } from 'node:crypto';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * DOI 规范化：`https://doi.org/10.1021/X` / `doi:10.1021/X` / `10.1021/X`
 * 统一成小写裸 DOI（字母大小写不敏感的 DOI 视为同一个）。
 * 返回 null 表示无法识别。
 */
export function normalizeDoi(input) {
  if (!input || typeof input !== 'string') return null;
  let s = input.trim();
  s = s.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '');
  s = s.replace(/^doi:\s*/i, '');
  s = s.replace(/^\/+/, '');
  s = s.trim().toLowerCase();
  if (!/^10\.\d{4,9}\/\S+$/.test(s)) return null;
  // 去掉尾部的空白与常见标点
  s = s.replace(/[.,;)\s]+$/, '');
  return s;
}

export const doiUrl = (doi) => (doi ? `https://doi.org/${doi}` : null);

/**
 * 标题归一化，用于「预印本 -> 正式版」的去重比较。
 * 只保留字母数字。
 */
export function normalizeTitle(title) {
  if (!title || typeof title !== 'string') return '';
  return title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/<[^>]*>/g, ' ')
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '');
}

export const sha256 = (text) =>
  createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex');

/** ISO 日期（YYYY-MM-DD，UTC） */
export function isoDate(d = new Date()) {
  return new Date(d).toISOString().slice(0, 10);
}

/** 从给定日期往前推 n 天，返回 YYYY-MM-DD */
export function daysBefore(days, from = new Date()) {
  const d = new Date(from);
  d.setUTCDate(d.getUTCDate() - days);
  return isoDate(d);
}

/** 两个 YYYY-MM-DD 之间相差的天数（b - a） */
export function dayDiff(a, b) {
  const ta = Date.parse(`${a}T00:00:00Z`);
  const tb = Date.parse(`${b}T00:00:00Z`);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return Infinity;
  return Math.round((tb - ta) / 86400000);
}

/** 去掉 HTML/XML 标签与实体，压平空白 */
export function stripMarkup(input) {
  if (!input || typeof input !== 'string') return '';
  return input
    .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/\s+/g, ' ')
    .trim();
}

/** 截断到指定字符数，尽量不切断单词 */
export function truncate(text, max = 1600) {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  return `${s.slice(0, max).replace(/\s+\S*$/, '')}…`;
}

/**
 * 原子写文件：先写临时文件再 rename，避免中途崩溃把线上数据写坏。
 */
export async function writeFileAtomic(fs, path, content) {
  const tmp = `${path}.${process.pid}.tmp`;
  await fs.writeFile(tmp, content, 'utf8');
  await fs.rename(tmp, path);
}
