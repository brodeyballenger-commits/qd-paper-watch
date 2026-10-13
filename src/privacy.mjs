/**
 * 隐私自检：守住一条线 —— 这个公开仓库（以及它生成的公开页面）里，
 * 永远不出现密钥、令牌、手机号、身份证号、本机绝对路径、私人邮箱。
 *
 * 这里只有纯函数：不读文件、不起子进程，方便单测。
 * 目录遍历与 git 历史扫描在 scripts/check-privacy.mjs。
 */

/** 允许出现的邮箱域名：示例域名 + 文档里合法引用的公共域名。 */
export const OK_EMAIL_DOMAINS = [
  'example.com',
  'example.org',
  'example.net',
  'github.com',
  'users.noreply.github.com',
  'githubusercontent.com',
  'deepseek.com',
  'openalex.org',
  'crossref.org',
  'doi.org',
];

/**
 * 规则表。`re` 里不要写 `g`：scanText 会按行重新构造带 `g` 的副本，
 * 这样同一份规则可以被反复调用而不受 lastIndex 影响。
 * `allow(hit)` 返回 true 表示这一处是白名单里的正常内容。
 */
export const PRIVACY_RULES = [
  {
    id: 'api-key',
    hint: '疑似 API key（如 DeepSeek / OpenAI 的 sk- 密钥）',
    re: /\bsk-[A-Za-z0-9_-]{16,}/,
  },
  {
    id: 'github-token',
    hint: '疑似 GitHub 令牌',
    re: /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  },
  {
    id: 'bearer',
    hint: '疑似请求头里的令牌',
    re: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/,
  },
  {
    id: 'cn-mobile',
    hint: '疑似手机号',
    re: /\b1[3-9]\d{9}\b/,
  },
  {
    id: 'cn-id',
    hint: '疑似身份证号',
    re: /\b\d{17}[\dXx]\b/,
  },
  {
    id: 'local-path',
    hint: '本机绝对路径（会暴露 Windows / macOS / Linux 用户名）',
    re: /(?<![A-Za-z0-9._~/-])(?:[A-Za-z]:\\+Users\\+[^\\\s"'`]+|\/home\/[A-Za-z0-9._-]+|\/Users\/[A-Za-z0-9._-]+)/,
    // 文档里用 `C:\Users\...`、`/home/...` 这种省略写法解释规则本身，不算泄露：
    // 真路径不会以省略号结尾，所以这个豁免藏不住东西。
    allow: (hit) => /(?:\.{2,}|…)$/.test(hit),
  },
  {
    id: 'personal-email',
    hint: '疑似私人邮箱',
    re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/,
    allow: (hit) => OK_EMAIL_DOMAINS.some((d) => hit.toLowerCase().endsWith('@' + d)),
  },
];

/**
 * 命中内容的可打印形式：只留极少量信息用于定位，绝不把要防的东西写进公开日志。
 * 邮箱保留域名（域名本身是通用信息），其余只留前两个字符。
 */
export function maskHit(hit, ruleId) {
  const at = hit.indexOf('@');
  if (ruleId === 'personal-email' && at > 0) return '***' + hit.slice(at);
  return hit.slice(0, 2) + '***';
}

/**
 * 扫描一段文本。
 * @param {string} text 待扫描内容
 * @param {{ id?: string }} [options] id 用于报告（通常是文件路径）
 * @returns {{ file: string, rule: string, hint: string, line: number, column: number, masked: string }[]}
 */
export function scanText(text, { id = '(内存)' } = {}) {
  const findings = [];
  const lines = String(text ?? '').split(/\r?\n/);

  for (const rule of PRIVACY_RULES) {
    const flags = rule.re.flags.includes('g') ? rule.re.flags : `${rule.re.flags}g`;
    const re = new RegExp(rule.re.source, flags);

    lines.forEach((line, index) => {
      re.lastIndex = 0;
      let hit;
      while ((hit = re.exec(line)) !== null) {
        if (hit[0].length === 0) break;
        if (!(rule.allow && rule.allow(hit[0]))) {
          findings.push({
            file: id,
            rule: rule.id,
            hint: rule.hint,
            line: index + 1,
            column: hit.index + 1,
            masked: maskHit(hit[0], rule.id),
          });
        }
        if (re.lastIndex <= hit.index) re.lastIndex = hit.index + 1;
      }
    });
  }

  return findings;
}
