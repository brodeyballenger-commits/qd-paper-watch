# 设计说明（specs/design.md）

## 1. 目标与非目标

**目标**

1. 每天自动抓取新发表的**量子点器件**论文（**主方向：量子点发光二极管 QD-LED**），范围覆盖期刊论文（不含综述以外的人工筛选）。
   主方向以叠加标签表达、站点默认聚焦，但**不排除**其它量子点器件论文（见 3.1.1）。
1.1. **只收已经正式见刊的论文**：多源发现（OpenAlex / Crossref / Semantic Scholar / arXiv，可选 Google 学术），arXiv 预印本必须能解析出期刊版本才入库（见 2、3.2.1）。
2. 从抓取结果中提取 **DOI**，保证每条记录都能点回原文。
3. 依据**摘要**生成中文的「做了什么 / 创新在哪」，让人 30 秒判断值不值得读。
4. 提供一个**固定网址**的静态网站，作者和同学随时可看；同时产出可离线分享的单文件版本。
5. 零运行时依赖、零服务器成本：抓取与生成在本地或 GitHub Actions 完成，托管用 GitHub Pages。

**非目标**

- 不做登录、不做多人协同标注（「已读」只存在各自浏览器里）。
- 不做全文解析、不做影响因子/分区计算。
- 不做论文推荐算法，只做「按时间 + 方向 + 创新度」的浏览与筛选。
- 不收录与器件无关的量子点材料学、生物成像、化学传感论文。
- 不收录**尚未见刊**的预印本（默认行为；`--include-preprints` 可手动放开）。
- 不把 Google 学术 / X-MOL / 百度学术当数据源（见 5. 站点一节的理由），只做跳转检索。

## 2. 数据源

多源发现 + **只收已见刊**（用户要求：arXiv、OpenAlex、Crossref、Semantic Scholar、Google 学术等来源都能抓，但论文必须已经正式见刊）。调度在 `src/sources.mjs`，每个源返回统一的 `{ works, total, dropped }`。

| 来源 | 默认 | 用途 | 见刊判定依据 | 备注 |
| --- | --- | --- | --- | --- |
| OpenAlex `/works` | ✅ | 主题命中 + 出版日期窗口；标题、作者、期刊、DOI、开放获取、被引数、`abstract_inverted_index` | `primary_location.source.type === 'journal'` | 免费无 key；`primary_topic.id` 命中 6 个量子点主题、`type:article`、`is_retracted:false`、`publication_date:desc`、游标分页、每页 200、最多 25 页 |
| Crossref `/works`（`src/crossref-works.mjs`） | ✅ | 按标题相关度检索的期刊论文，含 JATS 摘要与作者 | 它本身就是期刊论文登记库（filter 固定 `type:journal-article`） | **必须同时给 `from-pub-date` 与 `until-pub-date`**：只给下界时，`sort=published` 会把 2121 年的垃圾日期排在最前 |
| Semantic Scholar `/paper/search/bulk` | ✅ | `publicationTypes=JournalArticle` 的期刊论文 | `journal` 非空且 `publicationTypes` 含 `JournalArticle` | 匿名可用（限流较严，429 时退避重试）；`search/bulk` 一次给 1000 条，`publicationDateOrYear=<since>:` |
| Semantic Scholar `/paper/batch` | ✅ | **把 arXiv 预印本解析成期刊版本**（arXiv 源的必要依赖） | 返回的 `journal` + `externalIds.DOI` | 一次最多 500 个 ID，返回数组与入参**严格同序、未收录为 `null`**；单篇 DOI 直查对新论文会 404，所以只能用 bulk + batch |
| arXiv Atom API（`src/arxiv.mjs`） | ✅ | 只用它**发现**新预印本（`cond-mat.mtrl-sci` / `cond-mat.mes-hall` / `physics.app-ph` / `physics.optics`） | 必须经 Semantic Scholar 解析出期刊 DOI；`<arxiv:doi>` 可兜底，两者都没有就丢弃 | `<arxiv:journal_ref>` 实测几乎为空（0/8），不可依赖；实测 20 条预印本 → 16 条解析出期刊版本 |
| Google 学术（`src/scholar.mjs`，经 SerpApi） | ⬜ | `engine=google_scholar` 检索，补足其它源漏掉的论文 | 用 Crossref 按标题回查，相似度 ≥ 0.7 且拿到期刊 DOI 才入库 | **需要付费 `SERPAPI_KEY`**；没有 key 时自动跳过，不报错 |

抓取过滤条件（OpenAlex 分支）：`primary_topic.id` 命中 6 个量子点相关主题、`type:article`、`is_retracted:false`、`from_publication_date` 在窗口内，按 `publication_date:desc` 排序，游标分页，每页 200 条，最多 25 页。

**不使用 `from_created_date`**：该筛选项属于付费特性。

**摘要还原**：OpenAlex 返回的是「词 → 位置数组」的倒排索引，必须按 position 升序拼回，再清洗标签。这是最容易写错的一步，`test/abstract.test.mjs` 专门覆盖。

**单源失败隔离**：`fetchAllSources()` 用 `Promise.allSettled`，某个源挂了只记一行 `✗ 标签 失败（其它源继续）：msg`，只有全部源都失败才抛错中止。每个源的日志先缓冲、再按源顺序输出，避免多源并发时日志交错。

## 3. 处理流水线

```
build.mjs
  loadEnv()                 # .env 只补空缺，不覆盖已存在的环境变量（保证 CI Secret 优先）
  loadJson(papers.json)     # 已经存在的账本
  多源抓取（2）              # fetchAllSources()：OpenAlex / Crossref / Semantic Scholar / arXiv（+ 可选 Google 学术）
  dedupeCandidates()        # 同一篇论文被多个源发现 → 合并成一条（DOI / 标题归一化）
  见刊闸门（2.6）            # applyPublishedGate()：只留已经有正式期刊版本的论文
  摘要兜底（2.8）            # backfillAbstracts()：批量从 Semantic Scholar / OpenAlex 补缺失摘要
  evaluateRelevance()       # 逐篇闸门判定；必要时 Crossref 补摘要后重判
  makeRecord()              # 补齐派生字段（摘要哈希、排序日期、可疑日期、来源、见刊标记）
  mergeRecords()            # 与旧账本合并去重
  applyPublishedFieldsToLedger()  # 存量自愈：给多源改造之前的老记录补 sources / published
  主方向补标（4.5）           # isQledDevice()：给全账本补 qled 标签（幂等、只增不减、不花钱）
  summarizePapers()         # DeepSeek 生成中文总结（无 key 时整段跳过）
  saveJsonAtomic()          # 原子写 docs/data/papers.json 与封面数据
  renderSite()              # 生成 docs/ 与 standalone.html
```


### 3.0 文本归一化（`normalizeText`）

期刊标题大量使用 Unicode 连字符/短横线（U+2010–U+2015、U+2212 减号、U+FF0D 全角、U+00AD 软连字符），而词表里写的是 ASCII `-`。实测 270 篇账本中**标题含这类字符的有 65 篇、标题或摘要含的有 123 篇**；不归一化会漏掉 *Ultrahigh‑resolution quantum dot light‑emitting diodes*、*Interfacial Dipole Engineering of NiO x …* 这类论文（标题级 LED 证据 +9 篇，QD 证据 +0）。因此 `src/util.mjs` 的 `normalizeText()` 把所有破折号折成 `-`、把 NBSP 折成普通空格，`buildSearchText()` 与 `evaluateRelevance()` 的标题判定都先过它，**词表里统一写 ASCII 连字符**。

### 3.1 相关性闸门（决定网站质量的核心）

判定顺序（`src/relevance.mjs`）：

1. **先抹掉「碳点」**（`carbon dots` / `graphene quantum dots` / `CQDs` …），再做量子点判定 —— 否则 `carbon quantum dots` 会被误判成量子点。
   刻意**不把 `\bCDs\b` 当作碳点**：大小写不敏感会误伤 `CdS`。
2. **必须同时**满足：量子点证据（`QD_CORE_PATTERNS`）∩ 器件/应用证据（`DEVICE_PATTERNS`）。
3. **量子点证据必须在标题里**。摘要里顺口提一句 `quantum dots` 的论文太多（钙钛矿电池、通用光电材料都会提），只认标题级证据。
4. **无摘要时的兜底**：标题里没有 `quantum dot` 字样，但出现明确的量子点材料体系（`CdSe`/`ZnSe`/`PbS`…）或特征光物理（`blinking`/`trion`/`antibunching`…），**且**有**强**器件信号、且没踩噪音词时放行。这类论文只有标题可判，例如 *Optically Active Single Hole Spin in ZnSe*。
   该兜底**只对无摘要的论文启用**；有摘要的论文信息足够，放开会误收大量钙钛矿太阳能电池论文。
5. **噪音词**：命中生物医学/化学传感等噪音词的论文，只有在**没有任何强器件信号**时才丢弃。之所以留这个「逃生口」：QD-LED 论文摘要里也常出现 biomedical/in vivo 语境。

未通过时记录原因，便于调参：`no-quantum-dot` / `carbon-dot` / `no-qd-in-title` / `no-device-signal` / `noise:<ids>`；通过但走了兜底时记为 `weak-qd:<ids>`。

实测（2026-10-13）：14 天窗口 225 篇候选 → 保留 40 篇（约 3 篇/天）。

调参工具：`node .tmp/debug-relevance.mjs 14 --rejected`（仓库外工具，不提交）。

### 3.1.1 主方向：量子点发光二极管（QD-LED）

本站主方向是 QD-LED，用**叠加式标签**表达：`directions` 里加一个 `qled`，**不是**硬过滤、不删数据，站点默认只看它（前端第一个勾选框默认打开）。

判定（`src/relevance.mjs` 的 `qledFocus()` / `isQledDevice()`，词表在 `src/config.mjs`）：

- `QLED_STRONG_PATTERNS` 命中任意一条即算：`QD-LED` / `Q-LED` / `quantum dot light-emitting` / `light-emitting diodes` / `electroluminescence`。
- 否则 `QLED_SUPPORTING_PATTERNS` **必须至少两条同时命中**（裸 `LED` ＋ `microdisplay`／发光指标如 `luminance`/`cd/A`/`T50`／器件叠层如 `hole transport`、`emission layer`）。
  「两条」是实测出来的阈值：只靠裸 `\bLEDs?\b` 才命中的 9 篇里有 8 篇确实是 QD-LED，唯一假阳性是 *High-Efficiency Novel Cu3InSnS5 Quantum Dot Photovoltaics*（摘要里只有「under indoor LED illumination (1250 lx)」）。要求两条后，该类论文被挡住，而 *Ultra-High-Resolution Quantum Dot Microdisplays* 靠 `LED + microdisplay` 仍能进来。
- 标签由 `src/build.mjs` 的步骤 **4.5** 对**全账本**补标：幂等（已有 `qled` 就跳过）、只增不减、**不调用 LLM**（所以补标不花钱，也不改动已有中文总结），存量论文因此也能被正确筛出来。`mergeRecords` 与 `applySummary` 对 `directions` 都是取并集，历史标签不会被覆盖。
- 实测：270 篇账本 → **63 篇**标为 QD-LED（strong 触发 48 篇的 `QD-LED` 缩写、49 篇的 `light-emitting diodes`、14 篇的 `electroluminescence`，可重叠；仅靠 supporting 通过的 1 篇 = microdisplay）。`meta.stats.qled_focus` 记录该数量。

### 3.2 合并去重（候选层，`src/sources.mjs` 的 `dedupeCandidates`）

多源抓取最大的副作用是「同一篇论文被多个源各报一次」，所以先在最外层做一次硬合并：

- 只认两个硬条件：**DOI 相同**，或 `normalizeTitle` 之后**标题完全相同**。不做模糊匹配（宁可留两条，也不能把两篇不同论文并成一条）。
- 缺 DOI 或缺标题的候选直接丢弃（没法给读者一个稳定链接）。
- 合并时：
  - `sources` 取并集，卡片上显示「收录来源」；
  - **预印本 DOI 让位给期刊 DOI**，旧 DOI 进 `alt_dois`（最终写进 `alt_doi`），并同步修正 `doi_url`；
  - **venue 优先级**：只要目标记录的 venue 是预印本仓储名（`arXiv (Cornell University)` 之类）而新来的不是，就用新 venue 覆盖。否则先到的 arXiv 会盖住 `Advanced Materials`，合并后的记录会被见刊闸门误判成 `preprint-venue` 丢掉（这是实现时踩到的真实 bug）；
  - 摘要取更长的那个（并同步 `abstract_source`）；`cited_by_count` 取 max；`published` 取或。
- 同一标题合并后 DOI 会变，所以 `byDoi` 索引必须删旧键、写新键，否则后续同标题的第三条会重复入库。

### 3.2.1 见刊闸门（`src/published.mjs`）

用户要求「论文需要已经见刊」，所以在相关性判定之前先挡一道。`isPublishedWork(raw)` 按固定顺序判定，返回 `{ published, published_source, reason }`：

1. `raw.published === true` 直接放行（上游源已经确定它是期刊版本）；
2. 预印本 DOI（`10.48550/arxiv.` / `10.5281/zenodo.` / `10.2139/ssrn.` / `10.1101/` / `10.31219/osf.io`）→ 拒，`reason='preprint-doi'`；
3. venue 命中预印本仓储名（`PREPRINT_SOURCE_HINTS`）→ 拒，`reason='preprint-venue'`；
4. Crossref：`type === 'journal-article'` → 过；
5. Semantic Scholar：`venue` 非空且 `publicationTypes` 含 `JournalArticle`（或为空）→ 过；
6. OpenAlex：`source_type === 'journal'` → 过；
7. 兜底：`source_type === 'journal'` → 过；否则 `reason='no-journal-evidence'`。

- `applyPublishedGate(raws)` 返回 `{ published, dropped, stats:Map }`，构建日志按 reason 分组打印。
- `--include-preprints` 时不丢弃，只逐条如实写 `published` / `published_source`，卡片上给预印本加橙色徽章。
- `applyPublishedFieldsToLedger(papers)` 是**存量自愈**：多源改造之前的老记录没有 `sources` / `published` 字段，这里补齐（`sources` 缺省为 `['openalex']`，摘要来自 Crossref 时再加 `'crossref'`；`published` 按 `is_preprint !== true` 推断）。幂等，只补不改。

实测（2026-10-14 的 14 天窗口 dry-run）：四源共取回 1153 条 → 去重后 707 条 → 见刊闸门留 696 条、丢弃 11 条（`preprint-doi` 6 / `no-journal-evidence` 4 / `preprint-venue` 1）→ 相关性闸门再留 115 条。

### 3.2.2 摘要兜底（`src/abstract-backfill.mjs`）

摘要决定这个网站的核心价值：没有摘要，LLM 只能写「数据库未收录摘要」，创新度也只能给 1★。实测多源改造后的 334 篇里 **101 篇没有摘要**（Crossref 来源 53 / OpenAlex 48 / Semantic Scholar 2），其中 **28 篇属于默认可见的主方向 QD-LED** —— 不能不管。

**为什么必须批量**：旧实现是逐篇问 Crossref（每轮最多 60 次），实测**60 次 0 命中**——Crossref 对这些出版商就是没有 abstract。逐篇查既慢又无效（每轮白等 1 分钟），所以删掉了那条路径，改成两个批量接口：

1. `POST https://api.semanticscholar.org/graph/v1/paper/batch?fields=title,abstract`，id 用 `DOI:<doi>`，一次最多 500 篇（`s2LookupBatch`，返回与入参严格同序）；命中写 `abstract_source='semanticscholar'`。
2. 仍未补到的走 `GET https://api.openalex.org/works?filter=doi:a|b|c&select=doi,abstract_inverted_index&per-page=50`，用 `restoreAbstract` 还原倒排索引；命中写 `abstract_source='openalex'`。

- `MIN_ABSTRACT_LENGTH = 60`：短于此视为占位残片，**会写进去但不计入「补上」**，下轮仍会尝试。
- 位置：**见刊闸门之后、相关性判定之前**。摘要会参与相关性判定（标题级证据 + 摘要级器件/噪音信号）和 LLM 提示词，所以必须在这两步之前补齐；只读网络请求，`--dry-run` 也照常执行。
- 容错：两个接口都包了 try/catch，任何一个挂掉都不影响构建；都失败时日志写「两个兜底接口都没补到」，卡片照旧显示「数据库未收录摘要」。

### 3.3 主账本去重与合并（`src/store.mjs`）

- 主键是 **DOI**（`normalizeDoi` 统一大小写与 `https://doi.org/` 前缀）。
- 同标题（`normalizeTitle` 只保留字母数字，忽略大小写/标点/重音）且日期相差 ≤120 天的两条记录视为同一篇：
  - 预印本 → 正式版：用正式版记录替换，但**保留最初发现时间**，旧 DOI 记在 `alt_doi`（写入前过一遍 `normalizeDoi`）；
  - 其余情况：保留先到的那条，后到 DOI 记在 `alt_doi`（已有 `alt_doi` 时不覆盖）。
- `sources` 取并集；`published` 取或（只要有一轮见过刊就算已见刊）；`published_source` 优先取新的。
- `first_seen` 一旦写入不再改变；`last_updated` 每轮刷新。
- **摘要哈希不变就复用已有中文总结**（`carryLlm`），不重复花钱；摘要变了则作废、标记 `pending_summary`，下一轮重新生成。
- 输出按 `sort_date desc, first_seen desc` 排序。

### 3.4 可疑日期

期刊常给出「提前上线」的未来出版日期（实测出现 `2027-01-01`）。这类记录标记 `date_suspect`，排序日期退回 `first_seen`，避免永久钉在榜首，并在卡片上给出说明。

### 3.5 LLM 总结

- 模型：`deepseek-chat`（可用 `DEEPSEEK_MODEL` 覆盖），`response_format: json_object`，`temperature 0.2`，`max_tokens 900`，并发 4。
- 输出字段：`title_zh` / `innovation_zh` / `method_zh` / `directions` / `novelty_score`(1–5) / `novelty_reason` / `keywords_zh`。
- **缓存键** = `sha256(PROMPT_VERSION :: DOI :: abstract_hash)`，缓存文件随账本一起提交。改提示词必须同时改 `PROMPT_VERSION`，否则旧结果会被误用。
- **容错**：解析失败/字段越界会被归一化（方向取白名单、分数夹到 1–5、关键词最多 8 个）；网络错误与会话限流退避重试最多 3 次。
- **单篇失败不影响整轮**：标记 `summary_source='failed'` 且保持 `pending_summary`，下一轮自动重试。
- **无 key 时整段跳过**，论文保持 `pending_summary=true`，站点显示「中文总结待生成」。

## 4. 数据模型（`docs/data/papers.json`）

```jsonc
{
  "generated_at": "2026-10-13T15:36:00.000Z",
  "count": 40,
  "papers": [
    {
      "id": "10.1002/adma.202600001", "doi": "10.1002/adma.202600001",
      "doi_url": "https://doi.org/...", "title": "…", "title_zh": "…", "title_key": "…",
      "authors": ["…"], "venue": "Advanced Materials", "issn_l": "0935-9648",
      "source_type": "journal", "is_preprint": false, "alt_doi": null,
      "sources": ["openalex", "crossref"], "published": true, "published_source": "crossref",
      "pub_date": "2026-10-10", "pub_year": 2026, "date_suspect": false,
      "sort_date": "2026-10-10", "oa_status": "gold", "pdf_url": "…", "cited_by_count": 0,
      "abstract": "…", "abstract_hash": "…", "abstract_source": "openalex", "abstract_missing": false,
      "directions": ["qled", "display"], "novelty_score": 5, "novelty_reason": "…",
      "innovation_zh": "…", "method_zh": "…", "keywords_zh": ["…"],
      "summary_source": "llm", "llm_model": "deepseek-chat", "llm_at": "…",
      "pending_summary": false, "first_seen": "…", "last_updated": "…"
    }
  ]
}
```

`docs/data/meta.json` 供页面使用：`project` / `generated_at` / `count` / `window_days` / `directions` / `highNoveltyThreshold` / `stats` / `source` / `sources` / `source_stats` / `include_preprints` / `published_count` / `preprint_count` / `summary_engine`。

## 5. 站点

- `docs/` 是 GitHub Pages 的根目录，**全部由 `src/site/` 生成**，不要手改。
- 两种形态：
  - `docs/index.html` + `docs/assets/*` + `docs/data/*.json` —— 线上版本，数据与代码分离；
  - `docs/standalone.html` —— 数据与代码全部内联的单文件版本，可离线分享。
- 内联 JSON 时把 `<` 转义成 `\u003c`，防止论文摘要里出现 `</script>` 截断脚本。
- 前端零依赖、零构建，全部文本经 `escapeHtml` 转义。
- 「已读」存 `localStorage['qd-paper-watch:read']`，因此每个人的已读状态互不干扰。
- **默认只看已见刊**：筛选行第一个勾选框 `#only-published` 默认 `checked`，`state.onlyPublished` 让 `matches()` 先挡掉 `published === false` 的记录。数据来自多个源，默认把还没正式见刊的预印本挡在外面；只有手动跑过 `--include-preprints` 时才会出现这类记录，届时卡片上有橙色「预印本」徽章。
- **默认只看主方向**：勾选框 `#only-qled` 默认 `checked`，`state.onlyQled` 让 `matches()` 再按 `directions.includes('qled')` 过滤；`hint` 会显示「· 只看已见刊 · 只看量子点发光二极管」，取消勾选即回到全部器件论文，「重置筛选」把两个默认值一起恢复。这样主方向突出，但其它方向的数据一条都没少。
- **收录来源**：卡片底部显示「收录来源：OpenAlex / Crossref / Semantic Scholar / arXiv / Google 学术」，取自记录的 `sources` 字段。
- 外链分两类，都只 `target="_blank" rel="noopener"`：
  - **指向原文**：`DOI 原文`（`doi_url`，回退 `https://doi.org/<doi>`，302 到出版社）与 `开放获取 PDF`（`pdf_url`，仅开放获取时出现）。
  - **跳转检索**：`在别处查：Google 学术 / X-MOL / 百度学术`，分别拼 `https://scholar.google.com/scholar?q=<标题>`、
    `https://www.x-mol.com/paper/search/q?option=<标题>`、`https://xueshu.baidu.com/s?wd=<标题>`。
    这三个平台**不能作为数据源**：Google 学术无公开接口且禁止抓取，X-MOL / 百度学术的检索页是前端渲染 + 反爬（实测 X-MOL 只返回 7KB 的 Next.js 外壳、百度学术直接 403）。
    所以本站只做「按标题跳转检索」，不尝试搬运它们的条目，也不依赖它们做去重或补充元数据。
- 样式使用 CSS 变量 + `prefers-color-scheme` 自动深色，620px 以下单列。

## 6. 自动化

| 方式 | 触发 | 说明 |
| --- | --- | --- |
| GitHub Actions（`.github/workflows/update.yml`） | 每天 UTC 22:00（北京 06:00）或手动 | 先跑隐私自检与单测，再抓取渲染，只有 `docs/` 有变化才提交；key 来自仓库 Secret；`checkout` 用 `fetch-depth: 0` 以便扫全历史 |
| Windows 计划任务（`scripts/register-task.ps1`） | 每天指定时间 | 调用 `scripts/update.ps1`，日志写 `.tmp/update-YYYYMM.log`；可选 `-Push` |

CI 用到的 Secret：`DEEPSEEK_API_KEY`（中文总结，必需）；`SEMANTIC_SCHOLAR_API_KEY`、`SERPAPI_KEY`（都可选，前者提配额、后者启用 Google 学术源）。可选 Variable：`CONTACT_EMAIL`（OpenAlex 礼貌池）。

抓取必须由 Node 发起（本机 PowerShell 环境可能无法建立 TLS）。PowerShell 脚本只负责调度与日志。

## 7. 测试

`npm test`（`node --test`，Node 自动发现 `test/*.test.mjs`）覆盖：

- `util`：DOI 规范化、标题归一化、Unicode 连字符归一化（`normalizeText`）、日期计算、标签清洗、截断；
- `abstract`：倒排索引按 position 还原、Crossref JATS 清洗；
- `relevance`：六类判定路径（通过 / 碳点 / 标题无量子点 / 无器件信号 / 噪音 / 弱证据兜底）、`CdS` 不误判、带 `g` 正则的稳定性、`qledFocus`/`isQledDevice` 的强信号与「两条 supporting」阈值、U+2010 标题仍能认出 QD-LED、非发光器件论文不会被打上 `qled`；
- `store`：记录生成（含新字段 `sources`/`published`/`published_source`、`alt_doi` 归一化）、未来日期退回、摘要未变复用总结、摘要变化作废总结、预印本升级、`sources` 并集与 `published` 取或、重复条目合并、损坏文件抛错、原子写入；
- `published`：预印本 DOI/仓储名被拒、四个源各自的见刊判定、`applyPublishedGate` 分组计数、`applyPublishedFieldsToLedger` 自愈与幂等；
- `arxiv`：Atom feed 解析（含 `v1` 后缀剥离、`<arxiv:doi>`/`<arxiv:journal_ref>`/`primary_category`）、查询 URL 构造、预印本→期刊版本解析（S2 命中 / `<arxiv:doi>` 兜底 / 都没有则丢弃）；
- `semanticscholar`：bulk 检索 URL 参数、`x-api-key` 头、501 个 ID 分两块且**顺序严格对齐**、无 DOI 返回 `null`、**不预设 `published`**（交给闸门判定）；
- `crossref-works`：`select` **不得含 `subtype`**（会 HTTP 400）、URL 必须同时带 `from-pub-date` 与 `until-pub-date`、`type:journal-article`、条目映射（日期补 1、作者 ≤3 + et al.、JATS 摘要）；
- `scholar`：有无 `SERPAPI_KEY` 的行为、SerpApi URL、搜索结果解析、标题相似度阈值、用 Crossref 换期刊 DOI（`published_source='crossref'`）、无 key 不发请求；
- `sources`：`resolveSources` 默认/显式/自动追加 scholar/未知源报错/空列表报错、`dedupeCandidates` 的同 DOI 合并、摘要取长、预印本 DOI 让位、缺字段丢弃、合并后索引修正；
- `abstract-backfill`：缺摘要候选的收集（去重、短摘要视为缺、缺 DOI 跳过）、OpenAlex `filter=doi:` URL 构造、S2 命中写 `semanticscholar`、剩下交给 OpenAlex 倒排索引、两接口都失败不崩、没有候选时不发请求、同一 DOI 的多条记录一起补；
- `llm`：缓存键、JSON 容错解析、字段归一化、无 key 跳过、命中缓存、真实请求体与鉴权头（注入假 fetch）、单篇失败不影响整轮；
- `privacy`：七条规则各自命中、白名单邮箱不误报、掩码不泄露原文、同行多处命中与行列号、正常内容（cron/长哈希/长数字/网址里的 `/home/`）不误报、非字符串输入、重复扫描一致、**仓库自己的源码通过自检**、`.gitignore` 必须包含密钥与缓存目录。

共 119 个用例。敏感串在测试里一律用拼接构造（`'sk-' + 'a1b…'`），否则测试文件自己会被隐私自检判为泄露。

> 本机沙箱下 `node --test`（目录形式）会因为需要 spawn 子进程而 `EPERM`，可以用
> `node --test --test-isolation=none test/util.test.mjs test/abstract.test.mjs …`（显式列出全部用例文件，**不能给目录**）在单进程里跑完整套。

DeepSeek 的真实调用不在单测里（需要用真 key），首次填好 key 后跑一次 `npm run update` 即可端到端验证。

## 8. 安全与隐私

### 8.1 密钥

- `.env` 与任何含 key 的文件都在 `.gitignore` 中。
- key 只在构建期读取，页面产物里只有总结文本，没有 key、没有请求头。
- 交付前扫描 `docs/` 确认不含 `DEEPSEEK_API_KEY` / `sk-` 片段。
- CI 里 key 只来自 GitHub Actions Secret，日志自动打码。

### 8.2 隐私自检（`src/privacy.mjs` + `scripts/check-privacy.mjs`）

因为站点是公开托管的，**每次构建前都必须能证明「仓库内容里没有密钥和个人信息」**，所以把这件事做成可执行的检查而不是靠人肉 review。

- `src/privacy.mjs` 是纯函数层：`PRIVACY_RULES` 七条规则（`api-key` / `github-token` / `bearer` / `cn-mobile` / `cn-id` / `local-path` / `personal-email`），
  `OK_EMAIL_DOMAINS` 白名单（example.*、github.com、users.noreply.github.com、githubusercontent.com、deepseek.com、openalex.org、crossref.org、doi.org），
  `scanText(text, { id })` 逐行扫描并返回 `{file, rule, hint, line, column, masked}`。
- **只输出掩码**（邮箱 `***@域名`，其余前 2 字符 + `***`）：CI 失败时日志是公开的，不能让「报警」本身变成泄露。
- 每条规则重建一个带 `g` 的正则实例：带 `g` 的正则对象有 `lastIndex` 状态，跨行/跨次复用会漏报。
- `scripts/check-privacy.mjs` 是 CLI 外壳：默认扫工作区（`SKIP_DIRS` 跳过 `.git`/`node_modules`/`.cache`/`.tmp`/`docs` —— `docs` 是生成物，
  `SKIP_EXT` 跳过二进制，单文件超 2MB 跳过）；`--history` 用 `git log -p --all` 扫**全部提交历史**。
- **`.env` 只在工作区模式下跳过**（本机私密文件、不可能被提交，否则自检永远失败）；历史模式不跳过，因为 `.env` 一旦进过历史就是真泄露。
  `.env.example` 两种模式都要扫。
- 白名单是**域名级**而不是整串：白名单域名（deepseek.com、github.com 这类）出现在邮箱里算正常引用；
  同一个用户名换成私人邮箱域名（qq.com、163.com 这种）就必须报出来。
- 假阳性是设计取舍：宁可让人工确认（把域名加进白名单要改代码、走 PR），也不放行一个真泄露。

### 8.3 身份

- 提交身份统一为 GitHub 的 noreply 邮箱，历史里不出现真实邮箱。
- 页面零第三方脚本/字体/统计，无作者名与联系方式。
- CI 第一步 `node scripts/check-privacy.mjs --history`（`actions/checkout` 带 `fetch-depth: 0` 才有完整历史）失败即不发布。
- 剩余的「元数据侧」暴露面（托管账号的其他公开仓库等）属于账号层面的选择，见 README 第 8 节的三个档位。

