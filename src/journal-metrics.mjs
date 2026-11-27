// src/journal-metrics.mjs
// 期刊评价数据 + 「必读栏」筛选规则。
//
// ⚠️ 这是一张**需要人工维护**的静态表，原因：中科院分区表与 JCR 影响因子都没有开放 API，
//    官方查询需要机构登录。所以这里只收录本站实际会碰到的刊物，并在每年新数据发布后手工更新。
//
//   - JCR_YEAR：影响因子取自 Clarivate JCR 的 Journal Impact Factor，保留一位小数；
//   - CAS_TIER_YEAR：分区取中科院文献情报中心《期刊分区表》升级版的**大类**分区（1/2/3）；
//   - 表里没有的刊一律视为「未收录」→ 不计入顶刊（宁可漏收，不可错收）。
//
// 更新方式：每年 6～7 月新 IF 发布后，改 JCR_YEAR / CAS_TIER_YEAR 和下面的数值即可，其余代码不用动。

export const JCR_YEAR = 2023;
export const CAS_TIER_YEAR = 2023;

/**
 * 键必须写成 normalizeVenue() 之后的样子（全小写、& 已解码、连字符已归一、无尾部标点）。
 * @type {Record<string, { impactFactor: number, tier: 1 | 2 | 3 }>}
 */
export const JOURNAL_METRICS = {
  // ---------- 综合顶刊 ----------
  'nature': { impactFactor: 50.5, tier: 1 },
  'science': { impactFactor: 44.7, tier: 1 },
  'nature reviews materials': { impactFactor: 79.8, tier: 1 },
  'nature nanotechnology': { impactFactor: 38.1, tier: 1 },
  'nature materials': { impactFactor: 37.2, tier: 1 },
  'nature electronics': { impactFactor: 33.7, tier: 1 },
  'nature photonics': { impactFactor: 32.3, tier: 1 },
  'nature chemistry': { impactFactor: 19.2, tier: 1 },
  'nature communications': { impactFactor: 14.7, tier: 1 },
  'science advances': { impactFactor: 11.7, tier: 1 },
  'national science review': { impactFactor: 16.3, tier: 1 },
  'science china physics mechanics and astronomy': { impactFactor: 7.0, tier: 2 },
  'research': { impactFactor: 11.0, tier: 1 },

  // ---------- 材料 / 化学 ----------
  'advanced materials': { impactFactor: 27.4, tier: 1 },
  'advanced functional materials': { impactFactor: 18.5, tier: 1 },
  'advanced energy materials': { impactFactor: 24.4, tier: 1 },
  'advanced science': { impactFactor: 14.3, tier: 1 },
  'advanced optical materials': { impactFactor: 8.0, tier: 2 },
  'advanced electronic materials': { impactFactor: 5.9, tier: 2 },
  'advanced materials technologies': { impactFactor: 6.8, tier: 3 },
  'small': { impactFactor: 13.0, tier: 1 },
  'small methods': { impactFactor: 10.7, tier: 2 },
  'small structures': { impactFactor: 8.6, tier: 2 },
  'materials today': { impactFactor: 24.2, tier: 1 },
  'materials today chemistry': { impactFactor: 7.0, tier: 2 },
  'materials today nano': { impactFactor: 3.9, tier: 3 },
  'materials today communications': { impactFactor: 3.8, tier: 3 },
  'materials futures': { impactFactor: 10.5, tier: 2 },
  'materials & design': { impactFactor: 7.6, tier: 1 },
  'materials research bulletin': { impactFactor: 5.3, tier: 2 },
  'materials chemistry and physics': { impactFactor: 4.3, tier: 2 },
  'materials science in semiconductor processing': { impactFactor: 4.1, tier: 2 },
  'materials science and engineering b': { impactFactor: 3.9, tier: 3 },
  'materials letters': { impactFactor: 2.7, tier: 3 },
  'materials': { impactFactor: 3.1, tier: 3 },
  'journal of materials chemistry c': { impactFactor: 6.4, tier: 2 },
  'journal of materials science materials in electronics': { impactFactor: 2.8, tier: 3 },
  'journal of alloys and compounds': { impactFactor: 5.8, tier: 2 },
  'journal of colloid and interface science': { impactFactor: 9.4, tier: 1 },
  'ceramics international': { impactFactor: 5.2, tier: 2 },
  'applied surface science': { impactFactor: 6.3, tier: 2 },
  'nanoscale': { impactFactor: 6.7, tier: 2 },
  'nanophotonics': { impactFactor: 6.5, tier: 2 },
  'nanomaterials': { impactFactor: 4.4, tier: 3 },
  'nanotechnology': { impactFactor: 2.9, tier: 3 },
  'micro and nanostructures': { impactFactor: 5.2, tier: 2 },
  'acs nanoscience au': { impactFactor: 3.2, tier: 3 },
  'acs omega': { impactFactor: 3.8, tier: 3 },
  'acs nano': { impactFactor: 15.8, tier: 1 },
  'nano letters': { impactFactor: 9.6, tier: 1 },
  'acs applied nano materials': { impactFactor: 5.5, tier: 2 },
  'acs applied materials & interfaces': { impactFactor: 8.3, tier: 2 },
  'acs applied electronic materials': { impactFactor: 4.7, tier: 3 },
  'chemistry of materials': { impactFactor: 7.2, tier: 2 },
  'the journal of physical chemistry letters': { impactFactor: 4.8, tier: 2 },
  'the journal of physical chemistry c': { impactFactor: 3.3, tier: 3 },
  'journal of the american chemical society': { impactFactor: 14.4, tier: 1 },
  'angewandte chemie international edition': { impactFactor: 16.1, tier: 1 },
  'accounts of chemical research': { impactFactor: 16.4, tier: 1 },
  'inorganic chemistry': { impactFactor: 4.3, tier: 2 },
  'chemical communications': { impactFactor: 4.9, tier: 2 },
  'chemical engineering journal': { impactFactor: 13.3, tier: 1 },
  'energy & environmental science': { impactFactor: 32.4, tier: 1 },
  'joule': { impactFactor: 38.6, tier: 1 },
  'matter': { impactFactor: 17.3, tier: 1 },
  'cell reports physical science': { impactFactor: 7.9, tier: 2 },
  'nano energy': { impactFactor: 17.1, tier: 1 },
  'acs energy letters': { impactFactor: 19.3, tier: 1 },
  'solar energy materials and solar cells': { impactFactor: 6.3, tier: 2 },
  'energy technology': { impactFactor: 3.8, tier: 3 },
  'international journal of extreme manufacturing': { impactFactor: 16.1, tier: 1 },

  // ---------- 光学 / 光电子 ----------
  'light science & applications': { impactFactor: 20.6, tier: 1 },
  'elight': { impactFactor: 27.2, tier: 1 },
  'laser & photonics review': { impactFactor: 9.8, tier: 1 },
  'laser & photonics reviews': { impactFactor: 9.8, tier: 1 },
  'optica': { impactFactor: 8.4, tier: 1 },
  'photonics research': { impactFactor: 7.6, tier: 1 },
  'advanced photonics nexus': { impactFactor: 6.0, tier: 2 },
  'acs photonics': { impactFactor: 6.5, tier: 2 },
  'optics express': { impactFactor: 3.8, tier: 2 },
  'optics communications': { impactFactor: 2.2, tier: 3 },
  'optics & laser technology': { impactFactor: 5.0, tier: 2 },
  'optical materials': { impactFactor: 3.8, tier: 3 },
  'optical and quantum electronics': { impactFactor: 3.0, tier: 3 },
  'optik': { impactFactor: 3.0, tier: 3 },
  'journal of luminescence': { impactFactor: 3.3, tier: 3 },
  'journal of lightwave technology': { impactFactor: 4.1, tier: 3 },
  'infrared physics & technology': { impactFactor: 3.2, tier: 3 },
  'optical engineering': { impactFactor: 1.4, tier: 3 },
  'journal of modern optics': { impactFactor: 1.3, tier: 3 },
  'laser physics': { impactFactor: 1.3, tier: 3 },
  'applied physics express': { impactFactor: 2.3, tier: 3 },
  'ieee photonics technology letters': { impactFactor: 2.3, tier: 3 },
  'ieee journal of selected topics in quantum electronics': { impactFactor: 4.3, tier: 2 },
  'ieee electron device letters': { impactFactor: 4.1, tier: 2 },

  // ---------- 物理 / 器件 ----------
  'physical review letters': { impactFactor: 8.1, tier: 1 },
  'physical review. b': { impactFactor: 3.7, tier: 2 },
  'prx quantum': { impactFactor: 9.7, tier: 1 },
  'quantum science and technology': { impactFactor: 6.7, tier: 2 },
  'applied physics letters': { impactFactor: 3.5, tier: 2 },
  'applied physics reviews': { impactFactor: 15.0, tier: 1 },
  'journal of applied physics': { impactFactor: 2.7, tier: 3 },
  'journal of physics d applied physics': { impactFactor: 3.1, tier: 3 },
  'journal of physics condensed matter': { impactFactor: 3.0, tier: 3 },
  'journal of physics and chemistry of solids': { impactFactor: 4.0, tier: 3 },
  'physica b condensed matter': { impactFactor: 2.8, tier: 3 },
  'physica e low-dimensional systems and nanostructures': { impactFactor: 2.9, tier: 3 },
  'physica scripta': { impactFactor: 2.9, tier: 3 },
  'physics letters a': { impactFactor: 2.3, tier: 3 },
  'chinese physics b': { impactFactor: 1.7, tier: 3 },
  'chinese journal of physics': { impactFactor: 4.6, tier: 2 },
  'journal of semiconductors': { impactFactor: 4.0, tier: 3 },
  'results in physics': { impactFactor: 5.3, tier: 2 },
  'journal of electronic materials': { impactFactor: 2.1, tier: 3 },
  'electronic materials letters': { impactFactor: 2.3, tier: 3 },

  // ---------- 生物 / 分析（只用于给偶发跨领域条目定级，不是本站主线） ----------
  'analytical chemistry': { impactFactor: 6.7, tier: 1 },
  'biosensors and bioelectronics': { impactFactor: 10.7, tier: 1 },
  'analytica chimica acta': { impactFactor: 5.7, tier: 2 },
  'microchemical journal': { impactFactor: 4.9, tier: 2 },
  'spectrochimica acta part a molecular and biomolecular spectroscopy': { impactFactor: 4.3, tier: 2 },
  'journal of chemical education': { impactFactor: 2.5, tier: 3 },

  // ---------- 其余在账本里出现过、但不在主线的刊物 ----------
  // 收录它们只是为了让卡片能显示 IF；IF 低 + 非一区，不会进入必读栏。
  'scientific reports': { impactFactor: 3.8, tier: 3 },
  'korean journal of chemical engineering': { impactFactor: 2.5, tier: 3 },
  'chemical physics impact': { impactFactor: 4.5, tier: 3 },
  'journal of information display': { impactFactor: 2.0, tier: 3 },
  'annals of physics': { impactFactor: 2.2, tier: 3 },
  'applied radiation and isotopes': { impactFactor: 1.5, tier: 3 },
  'results in engineering': { impactFactor: 6.0, tier: 2 },
  'inorganics': { impactFactor: 3.0, tier: 3 },
  'journal of magnetism and magnetic materials': { impactFactor: 2.7, tier: 3 },
  'viruses': { impactFactor: 3.8, tier: 3 },
  'chemosensors': { impactFactor: 3.8, tier: 3 },
};

/** 把刊名归一化：解码 HTML 实体、转小写、连字符归一、冒号折成空格、压缩空白、去掉尾部标点 */
export function normalizeVenue(venue) {
  const ENTITIES = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#39;': "'",
    '&apos;': "'",
    '&nbsp;': ' ',
  };
  return String(venue ?? '')
    .replace(/&[a-z#0-9]+;/gi, (entity) => ENTITIES[entity.toLowerCase()] ?? entity)
    .replace(/[\u2010-\u2015\u2212\u00ad]/g, '-')
    .toLowerCase()
    .replace(/:/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.,;]+$/, '')
    .trim();
}

/**
 * 查刊名对应的指标。**只用归一化后的精确全等匹配，绝不做前缀匹配** ——
 * 否则 "Advanced Materials Technologies" 会被 "Advanced Materials" 误判成 IF 27.4。
 * 脏数据里存在 "Physical review. B./Physical review. B" 这种同一刊名被拼接的写法，
 * 因此全等失配时再按 "/" 切开逐段重试。
 * @returns {{ name: string, impactFactor: number, tier: 1|2|3 } | null}
 */
export function lookupJournal(venue) {
  const key = normalizeVenue(venue);
  if (!key) return null;

  const direct = JOURNAL_METRICS[key];
  if (direct) return { name: key, ...direct };

  if (key.includes('/')) {
    for (const part of key.split('/')) {
      const trimmed = part.trim();
      const hit = JOURNAL_METRICS[trimmed];
      if (hit) return { name: trimmed, ...hit };
    }
  }
  return null;
}

/**
 * 「必读栏」筛选规则（前端按此计算，构建期不做筛选，免得改规则要重跑抓取）：
 *  1) 顶刊：近 windowDays 天内、中科院一区、影响因子 ≥ topMinIf；
 *  2) 高创新补足：顶刊不足 limit 张时，用「一区 ∧ 影响因子 ≥ fallbackMinIf ∧ 创新度 ≥ fallbackMinNovelty」补齐；
 *  3) 顶刊永远排在高创新之前。
 * 时间锚点用数据里最新的一篇论文日期，而不是浏览器当前时间 —— 否则隔几天不开站点就会整栏变空。
 */
export const MUST_READ = {
  windowDays: 90,
  topMinIf: 20,
  fallbackMinIf: 15,
  fallbackMinNovelty: 4,
  limit: 6,
};

/**
 * 机器可识别的非研究性条目（评论 / 勘误 / 编者按）。
 * 注意**不包含** review / perspective —— 综述对追踪领域进展有价值，应当保留。
 */
export const NON_RESEARCH_TITLE_PATTERNS = [
  /^news\s*(?:&|and)\s*views?\b/i,
  /^(?:commentary|comment)\b/i,
  /^editorial\b|^editor['\u2019]s note\b/i,
  /^(?:correspondence|letter to the editor)\b/i,
  /^(?:in this issue|issue highlights?|research highlights?)\b/i,
  /^(?:retraction|retraction note|erratum|corrigendum|correction|author correction|publisher correction)\b/i,
  /^(?:book review|obituary|in memoriam)\b/i,
];

/**
 * 手工黑名单：机器无法区分、但已人工确认不是研究论文的 DOI。
 * Nature 系的 News & Views 在 OpenAlex / Crossref 里都只是普通的 journal-article，
 * 没有摘要也没有任何结构化标记，只能靠这里点名排除。
 */
export const MANUAL_EXCLUDE_DOIS = [
  // Nature Nanotechnology, 2026-10-01 —— 对「QD 显示」进展的评论，非研究论文
  '10.1038/s41565-026-02285-z',
  // Nature Nanotechnology, 2026-09-14 —— 对上面那篇可拉伸 QD 显示的 News & Views
  '10.1038/s41565-026-02278-y',
];

/**
 * 判断一条记录是否不属于研究性论文。
 * @returns {'manual' | 'title' | null} 命中原因，null 表示是正常论文
 */
export function nonResearchReason(record) {
  const doi = String(record?.doi ?? '').toLowerCase().trim();
  if (doi && MANUAL_EXCLUDE_DOIS.includes(doi)) return 'manual';

  const title = String(record?.title ?? '').trim();
  if (!title) return null;
  for (const pattern of NON_RESEARCH_TITLE_PATTERNS) {
    if (pattern.test(title)) return 'title';
  }
  return null;
}

/**
 * 给账本里的论文补上游期刊指标（影响因子 / 分区）。
 * 幂等、纯规则、**不调 LLM 不花钱**：老论文、每次跑都一样，指标被删掉也会自动补回。
 * @returns {number} 本次发生变化的篇数
 */
export function applyJournalMetrics(papers) {
  let changed = 0;
  for (const paper of papers) {
    const metric = lookupJournal(paper.venue);
    const nextIf = metric ? metric.impactFactor : null;
    const nextTier = metric ? metric.tier : null;
    // 用 ?? null 归一化：字段缺失时是 undefined，不能和 null 直接做全等比较，否则每轮都会被算成「变化」
    if ((paper.journal_if ?? null) === nextIf && (paper.journal_tier ?? null) === nextTier) continue;

    if (nextIf == null) {
      delete paper.journal_if;
      delete paper.journal_tier;
    } else {
      paper.journal_if = nextIf;
      paper.journal_tier = nextTier;
    }
    changed += 1;
  }
  return changed;
}
