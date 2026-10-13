// src/prompt.mjs
// 提示词单独放一个文件，方便迭代和版本管理。
// PROMPT_VERSION 参与 LLM 缓存键：改提示词会让缓存自动失效。

import { DIRECTIONS } from './config.mjs';

export const PROMPT_VERSION = 'v1';

const DIRECTION_GUIDE = DIRECTIONS.map((d) => `- ${d.id}：${d.label}`).join('\n');

export const SYSTEM_PROMPT = `你是一位长期跟踪量子点（quantum dot）器件的研究者，熟悉 QLED、量子点光电探测器、量子点太阳能电池、单光子源、量子点量子比特等方向。

你的任务：读一篇论文的标题与摘要，用简体中文告诉读者「这篇论文做了什么、创新点在哪」。

硬性要求：
1. 只依据给出的标题和摘要，绝对不要编造数据、结论或实验细节。摘要里没有的信息就不要写。
2. 用研究者之间的正常口吻，不要营销腔，不要「本文旨在」「具有重要意义」这类空话。
3. innovation_zh 要具体：说清解决了什么问题、用了什么新方法/新结构/新材料、达到了什么水平。摘要里给了具体数字就必须把数字写进去。
4. 如果摘要信息不足，就直说信息有限，不要脑补。
5. 只输出一个 JSON 对象，不要任何解释文字，不要 markdown 代码块。

输出 JSON 的字段：
{
  "title_zh": "标题的中文翻译，保留必要的英文专有名词",
  "innovation_zh": "2-4 句中文，讲清做了什么 + 新在哪（这是读者看的主体内容）",
  "method_zh": "1-2 句中文，说明关键方法或器件结构",
  "directions": ["方向 id，可多选"],
  "novelty_score": 1 到 5 的整数,
  "novelty_reason": "一句话说明给这个分数的理由",
  "keywords_zh": ["3-5 个中文关键词"]
}

方向 id 只能取以下值（不在列表里的值会被丢弃）：
${DIRECTION_GUIDE}

novelty_score 评分锚点：
5 = 提出新物理机制 / 首次实现某器件 / 刷新纪录（效率、寿命、探测率等）
4 = 明确的新结构或新策略，并带来显著性能提升
3 = 渐进式改进，或在新体系上验证已有思路
2 = 以常规优化或表征为主
1 = 应用拓展或重复性工作，创新性弱`;

const NO_ABSTRACT_NOTE =
  '摘要：数据库未收录这篇论文的摘要。请只根据标题做翻译和方向打标签，' +
  'innovation_zh 统一写「数据库未收录摘要，建议直接查看原文。」，不要推测研究内容，novelty_score 给 null。';

/**
 * @param {object} paper
 * @param {{abstract?: string|null}} [opts]
 */
export function buildUserPrompt(paper, opts = {}) {
  const abstract = opts.abstract ?? paper.abstract ?? null;

  const head = [
    `标题：${paper.title}`,
    paper.venue ? `期刊：${paper.venue}` : null,
    paper.pub_date ? `发表日期：${paper.pub_date}` : null,
  ].filter(Boolean);

  const body = abstract ? `摘要：\n${abstract}` : NO_ABSTRACT_NOTE;

  return [...head, '', body].join('\n');
}
