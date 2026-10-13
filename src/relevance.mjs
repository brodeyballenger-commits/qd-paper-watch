// src/relevance.mjs
// 决定网站质量的核心闸门：在调用 LLM（花钱）之前，先用确定性规则把范围外的论文挡掉。
// 实测噪音来源：碳点生物诊疗、VCSEL/DFB 通用激光、纯理论/热力学论文、碳点传感。

import {
  CARBON_DOT_PATTERNS,
  DEVICE_PATTERNS,
  MATERIALS_PATTERNS,
  NOISE_PATTERNS,
  PREPRINT_SOURCE_HINTS,
  QD_CORE_PATTERNS,
  QD_WEAK_PATTERNS,
} from './config.mjs';

const CARBON_SOURCE = CARBON_DOT_PATTERNS.map((p) => `(?:${p.source})`).join('|');
// 注意：带 g 的正则有 lastIndex 状态，必须区分「替换用」和「判断用」两个实例
const CARBON_RE_GLOBAL = new RegExp(CARBON_SOURCE, 'gi');
const CARBON_RE_TEST = new RegExp(CARBON_SOURCE, 'i');

/** 把「碳点」相关短语整体抹掉，避免被当成量子点 */
export function stripCarbonDots(text) {
  return String(text ?? '').replace(CARBON_RE_GLOBAL, ' ');
}

export function hasCarbonDot(text) {
  return CARBON_RE_TEST.test(String(text ?? ''));
}

export function buildSearchText(paper) {
  return [paper?.title, paper?.abstract, paper?.venue].filter(Boolean).join(' \n ');
}

function testAll(patterns, text) {
  return patterns.filter((p) => p.re.test(text)).map((p) => p.id);
}

const STRONG_DEVICE = DEVICE_PATTERNS.filter((p) => p.strength === 'strong');

/** 判定是否预印本/仓储版本（不是正式期刊论文） */
export function isPreprint(paper) {
  const venue = String(paper?.venue ?? '').toLowerCase();
  if (PREPRINT_SOURCE_HINTS.some((h) => venue.includes(h))) return true;
  return paper?.source_type != null && paper.source_type !== 'journal';
}

/** 方向打标：先用规则给出种子标签，LLM 之后会再补充一轮 */
export function tagDirections(text, deviceIds) {
  const tags = new Set();

  for (const p of DEVICE_PATTERNS) {
    if (deviceIds.includes(p.id)) {
      for (const d of p.directions) tags.add(d);
    }
  }

  if (MATERIALS_PATTERNS.some((p) => p.test(text))) tags.add('materials');

  if (tags.size === 0) tags.add('materials'); // 兜底：不至于出现没有方向的卡片
  return [...tags];
}

/**
 * 判定一篇论文是否属于本站范围。
 *
 * @returns {{pass: boolean, reason: string|null, directions: string[], detail: object}}
 *   reason 取值：no-quantum-dot / carbon-dot / no-device-signal / noise:<ids> / weak-qd:<ids>（通过）
 */
export function evaluateRelevance(paper) {
  const raw = buildSearchText(paper);
  const text = stripCarbonDots(raw);
  const titleText = stripCarbonDots(String(paper?.title ?? ''));
  const hasAbstract = Boolean(paper?.abstract);

  const qdHits = testAll(QD_CORE_PATTERNS, text);
  // 标题级证据：摘要里顺口提一句 "quantum dots" 的论文太多了，
  // 只有标题本身站在量子点上，才算真正对口。
  const titleQdHits = testAll(QD_CORE_PATTERNS, titleText);
  const deviceHits = testAll(DEVICE_PATTERNS, text);
  const strongDeviceHits = testAll(STRONG_DEVICE, text);
  const noiseHits = testAll(NOISE_PATTERNS, text);
  const carbonDot = hasCarbonDot(raw);

  const weakQdHits = titleQdHits.length === 0 ? testAll(QD_WEAK_PATTERNS, titleText) : [];

  const detail = {
    qdHits,
    titleQdHits,
    weakQdHits,
    deviceHits,
    strongDeviceHits,
    noiseHits,
    hasAbstract,
    carbonDot,
  };

  if (qdHits.length === 0 || titleQdHits.length === 0) {
    // 摘要缺失时用材料体系/光物理特征兜底，但必须同时具备强器件信号且不踩噪音词。
    // 只在无摘要时启用：有摘要的论文信息足够，放开会误收大批钙钛矿太阳能电池类论文。
    const rescued =
      !hasAbstract && weakQdHits.length > 0 && strongDeviceHits.length > 0 && noiseHits.length === 0;

    if (!rescued) {
      let reason = 'no-quantum-dot';
      if (carbonDot) reason = 'carbon-dot';
      else if (qdHits.length > 0) reason = 'no-qd-in-title';
      return { pass: false, reason, directions: [], detail };
    }
    return {
      pass: true,
      reason: `weak-qd:${weakQdHits.join('+')}`,
      directions: tagDirections(text, deviceHits),
      detail,
    };
  }

  if (deviceHits.length === 0) {
    return { pass: false, reason: 'no-device-signal', directions: [], detail };
  }
  if (noiseHits.length > 0 && strongDeviceHits.length === 0) {
    return { pass: false, reason: `noise:${noiseHits.join('+')}`, directions: [], detail };
  }

  return { pass: true, reason: null, directions: tagDirections(text, deviceHits), detail };
}
