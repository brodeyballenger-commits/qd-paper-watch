// src/env.mjs
// 零依赖的 .env 加载器。
// 语义：已经存在的环境变量优先（这样 GitHub Actions 的 Secret 不会被 .env 覆盖），
// 只有「未定义或为空」的键才会从 .env 补上。

import fs from 'node:fs';
import path from 'node:path';

export function loadEnv(file = path.resolve(process.cwd(), '.env')) {
  let text;
  try {
    if (!fs.existsSync(file)) return false;
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return false;
  }

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (process.env[key] === undefined || process.env[key] === '') {
      process.env[key] = value;
    }
  }
  return true;
}
