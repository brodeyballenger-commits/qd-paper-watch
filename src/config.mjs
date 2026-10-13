// src/config.mjs
// 所有可调参数集中在这里，避免魔法值散落各处。
// 词表是基于本次实测抓到的真实论文调出来的，改动前请先跑 `npm test`。

export const PROJECT_NAME = '量子点器件前沿追踪';

/**
 * OpenAlex topic —— 实测筛出的量子点 / 半导体器件相关主题。
 * T13182（Quantum-Dot Cellular Automata）是计算机科学方向，故意不选。
 */
export const TOPIC_IDS = [
  'T10321', // Quantum Dots Synthesis And Properties
  'T11342', // Carbon and Quantum Dots Applications
  'T10022', // Semiconductor Quantum Structures and Devices
  'T11429', // Semiconductor Lasers and Optical Devices
  'T11637', // Advanced Semiconductor Detectors and Materials
  'T11169', // Silicon Nanostructures and Photoluminescence
];

export const EXCLUDED_TOPIC_IDS = ['T13182'];

/** 抓取窗口 */
export const PAGE_SIZE = 200;
export const DEFAULT_WINDOW_DAYS = 14;
export const MAX_WINDOW_DAYS = 400;

/** 请求节流与重试（OpenAlex 礼貌池约 10 req/s，Crossref 更保守） */
export const REQUEST_DELAY_MS = 130;
export const CROSSREF_DELAY_MS = 1000;
export const MAX_RETRIES = 4;
export const TIMEOUT_MS = 30000;

/** LLM */
export const LLM_CONCURRENCY = 4;
export const LLM_MAX_RETRIES = 3;
export const LLM_MAX_TOKENS = 900;
export const LLM_TEMPERATURE = 0.2;
export const DEFAULT_MODEL = 'deepseek-chat';
export const DEFAULT_BASE_URL = 'https://api.deepseek.com';

/** 界面上「只看高创新」的阈值 */
export const HIGH_NOVELTY_THRESHOLD = 4;

/* ------------------------------------------------------------------ *
 * 相关性词表
 * 闸门逻辑：必须同时命中「量子点证据」和「器件证据」；
 * 命中噪音词且没有强器件证据时丢弃。
 * ------------------------------------------------------------------ */

const re = (pattern) => new RegExp(pattern, 'i');

/** 量子点证据：命中任意一条即算 */
export const QD_CORE_PATTERNS = [
  { id: 'quantum-dot', re: re(String.raw`quantum[\s._-]?dots?\b`) },
  { id: 'qd-abbrev', re: re(String.raw`\bQDs?\b`) },
  { id: 'qled', re: re(String.raw`\bQD[\s-]?LEDs?\b`) },
  { id: 'qled-word', re: re(String.raw`\bQLEDs?\b`) },
  { id: 'qd-device-abbrev', re: re(String.raw`\bQD(IP|SC|FET|LED|photodetector)s?\b`) },
  { id: 'nanocrystal', re: re(String.raw`\bnanocrystals?\b`) },
  { id: 'nanoplatelet', re: re(String.raw`\bnanoplatelets?\b|\bNPLs?\b`) },
];

/**
 * 碳点（carbon dots）不是量子点，属于另一类材料。
 * 先把这些短语从文本中抹掉，再做量子点判定，
 * 这样「carbon quantum dots」就不会被误判成 quantum dots。
 * 注意：故意不包含 `\bCDs\b` —— 大小写不敏感会误伤「CdS」这种量子点材料。
 */
export const CARBON_DOT_PATTERNS = [
  re(String.raw`carbon\s+(nano)?dots?\b`),
  re(String.raw`carbon\s+quantum\s+dots?\b`),
  re(String.raw`graphene\s+quantum\s+dots?\b`),
  re(String.raw`carbonized\s+\w*\s*dots?\b`),
  re(String.raw`\bCQDs?\b`),
];

/**
 * 弱量子点证据：只有在「摘要缺失」时才用来兜底。
 * 实测场景：「Optically Active Single Hole Spin in ZnSe」这类论文标题里
 * 不出现 quantum dot 字样，但材料体系 + 强器件信号足以判定它属于本领域。
 * 不做全局启用，否则钙钛矿太阳能电池等大批论文会被误收。
 */
export const QD_WEAK_PATTERNS = [
  { id: 'material',
    re: re(String.raw`\bCdSe\b|\bCdS\b|\bCdTe\b|\bZnSe\b|\bZnS\b|\bZnTe\b|\bInP\b|\bInAs\b|\bPbS\b|\bPbSe\b|\bPbTe\b|\bHgTe\b|\bCuInS2\b|\bAgInS2\b|\bCsPb\w+|\bGaSb\b|\bInSb\b`) },
  { id: 'photophysics',
    re: re(String.raw`blinking|\btrions?\b|charged exciton|exciton fine structure|single[\s-]?emitter|single[\s-]?dot|photon statistics|antibunching`) },
];

/** 器件证据。strong=true 表示这是明确的器件/应用信号。 */
export const DEVICE_PATTERNS = [
  { id: 'led', strength: 'strong', directions: ['display'],
    re: re(String.raw`\bLEDs?\b|light[\s-]?emitting|electroluminesc`) },
  { id: 'display', strength: 'strong', directions: ['display'],
    re: re(String.raw`\bdisplays?\b|backlight|color conversion|downconversion|micro[\s-]?LED`) },
  { id: 'laser', strength: 'strong', directions: ['display'],
    re: re(String.raw`\blasers?\b|\blasing\b|optical gain|amplified spontaneous emission|\bASE\b`) },
  { id: 'photodetector', strength: 'strong', directions: ['detection'],
    re: re(String.raw`photodetector|\bdetectors?\b|photodiode|phototransistor|photoconduct|photocurrent|responsivity|detectivity|image sensor|\bimagers?\b|\bfocal[\s-]plane`) },
  { id: 'photovoltaic', strength: 'strong', directions: ['detection'],
    re: re(String.raw`photovolta|solar cells?`) },
  { id: 'transistor', strength: 'strong', directions: ['materials'],
    re: re(String.raw`\btransistors?\b|\bFETs?\b|\bTFTs?\b`) },
  { id: 'quantum-info', strength: 'strong', directions: ['quantuminfo'],
    re: re(String.raw`\bqubits?\b|single[\s-]?photon|spin qubit|spinqubit|entangle|quantum comput|\bCoulomb blockade|coherence time|electron spin|hole spin|spin[\s-]?orbit|valleytronic`) },
  { id: 'emitter', strength: 'weak', directions: ['display'],
    re: re(String.raw`\bemitters?\b|\bluminescence|photoluminescence|quantum yield|\bEL\b|\bPL\b|\bEQE\b`) },
  { id: 'sensor', strength: 'weak', directions: ['detection'],
    re: re(String.raw`\bsensors?\b|\bsensing\b|\bdetection\b|\bimaging\b|\bSWIR\b|\bNIR\b|infrared`) },
];

/** 噪音：命中且没有强器件证据时丢弃 */
export const NOISE_PATTERNS = [
  { id: 'bio-medical',
    re: re(String.raw`theranostic|drug delivery|targeted delivery|bioimag|biomedic|antibacterial|antimicrobial|\bcancer\b|tumou?r|carcinoma|cytotoxic|in vitro|in vivo|photothermal|wound healing|tissue repair|immuno|bacteri|cellular uptake|biocompat|antioxidant|scaveng|biological matrices|physiological`) },
  { id: 'chem-sensing',
    re: re(String.raw`fluorescent\s+(probe|sensors?|detection)|ratiometric|colorimetric|chemodosimeter|naked[\s-]eye|smartphone[\s-]assisted|selective\s+[\w\s-]{0,24}?(detection|sensing|determination)|\bLOD\b|detection limit|test strips?|\bprobe for\b|\bsensing platform\b|\bsensors?\b|\bsensing\b|ultrasensitive|\bassay\b|analyte|\bvitamin|cysteine|glutathione|dopamine|\bglucose\b|pesticide|antibiotic|food samples?|water samples?|real samples?`) },
  { id: 'cellular-automata',
    re: re(String.raw`cellular automata`) },
  { id: 'unrelated-physics',
    re: re(String.raw`Kronig[\s.]{0,2}Penney|microcanonical|thermodynamic beta|VCSEL|DFB laser`) },
];

/** 「材料与合成」方向的补充证据 */
export const MATERIALS_PATTERNS = [
  re(String.raw`\bsynthes[ie]|\bligand|passivation|doping|dopant|nucleation|epitax|core[\s/-]?shell|alloy|encapsulat|photostability|precursor|surface chemistry|colloidal|self[\s-]?assembl`),
];

/** 界面上的方向定义。id 必须与上面 directions 里的取值一致。 */
export const DIRECTIONS = [
  { id: 'display', label: '显示与发光', color: '#f59e0b' },
  { id: 'detection', label: '光电探测与光伏', color: '#10b981' },
  { id: 'quantuminfo', label: '量子信息器件', color: '#6366f1' },
  { id: 'materials', label: '材料与合成', color: '#ec4899' },
];

export const DIRECTION_IDS = DIRECTIONS.map((d) => d.id);

/** 名字里带这些的「期刊」其实是预印本/仓储，打上 preprint 标记 */
export const PREPRINT_SOURCE_HINTS = [
  'arxiv', 'zenodo', 'research square', 'researchsquare', 'ssrn', 'biorxiv',
  'medrxiv', 'chemrxiv', 'preprints.org', 'osf', 'pubmed', 'repository',
];
