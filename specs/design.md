# 设计说明（specs/design.md）

## 1. 目标与非目标

**目标**

1. 每天自动抓取新发表的**量子点器件**论文，范围覆盖期刊论文（不含综述以外的人工筛选）。
2. 从抓取结果中提取 **DOI**，保证每条记录都能点回原文。
3. 依据**摘要**生成中文的「做了什么 / 创新在哪」，让人 30 秒判断值不值得读。
4. 提供一个**固定网址**的静态网站，作者和同学随时可看；同时产出可离线分享的单文件版本。
5. 零运行时依赖、零服务器成本：抓取与生成在本地或 GitHub Actions 完成，托管用 GitHub Pages。

**非目标**

- 不做登录、不做多人协同标注（「已读」只存在各自浏览器里）。
- 不做全文解析、不做影响因子/分区计算。
- 不做论文推荐算法，只做「按时间 + 方向 + 创新度」的浏览与筛选。
- 不收录与器件无关的量子点材料学、生物成像、化学传感论文。

## 2. 数据源

| 来源 | 用途 | 备注 |
| --- | --- | --- |
| OpenAlex `/works` | 主数据源：标题、作者、期刊、DOI、出版日期、开放获取状态、`abstract_inverted_index` | 免费、无需 key；`select` 显式列出字段；`CONTACT_EMAIL` 建议填写以获得更稳定的配额 |
| Crossref `/works/{doi}` | 补充摘要 | 仅在 OpenAlex 缺摘要且标题已含量子点证据时调用，单轮上限 60 次，自身节流 1 秒 |

抓取过滤条件：`primary_topic.id` 命中 6 个量子点相关主题、`type:article`、`is_retracted:false`、`from_publication_date` 在窗口内，按 `publication_date:desc` 排序，游标分页，每页 200 条，最多 25 页。

**不使用 `from_created_date`**：该筛选项属于付费特性。

**摘要还原**：OpenAlex 返回的是「词 → 位置数组」的倒排索引，必须按 position 升序拼回，再清洗标签。这是最容易写错的一步，`test/abstract.test.mjs` 专门覆盖。

## 3. 处理流水线

```
build.mjs
  loadEnv()                 # .env 只补空缺，不覆盖已存在的环境变量（保证 CI Secret 优先）
  loadJson(papers.json)     # 已经存在的账本
  fetchWorks()              # OpenAlex 分页抓取
  evaluateRelevance()       # 逐篇闸门判定；必要时 Crossref 补摘要后重判
  makeRecord()              # 补齐派生字段（摘要哈希、排序日期、可疑日期标记）
  mergeRecords()            # 与旧账本合并去重
  summarizePapers()         # DeepSeek 生成中文总结（无 key 时整段跳过）
  saveJsonAtomic()          # 原子写 docs/data/papers.json 与封面数据
  renderSite()              # 生成 docs/ 与 standalone.html
```

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

### 3.2 去重与合并

- 主键是 **DOI**（`normalizeDoi` 统一大小写与 `https://doi.org/` 前缀）。
- 同标题（`normalizeTitle` 只保留字母数字，忽略大小写/标点/重音）且日期相差 ≤120 天的两条记录视为同一篇：
  - 预印本 → 正式版：用正式版记录替换，但**保留最初发现时间**，旧 DOI 记在 `alt_doi`；
  - 其余情况：保留先到的那条，后到 DOI 记在 `alt_doi`。
- `first_seen` 一旦写入不再改变；`last_updated` 每轮刷新。
- **摘要哈希不变就复用已有中文总结**（`carryLlm`），不重复花钱；摘要变了则作废、标记 `pending_summary`，下一轮重新生成。
- 输出按 `sort_date desc, first_seen desc` 排序。

### 3.3 可疑日期

期刊常给出「提前上线」的未来出版日期（实测出现 `2027-01-01`）。这类记录标记 `date_suspect`，排序日期退回 `first_seen`，避免永久钉在榜首，并在卡片上给出说明。

### 3.4 LLM 总结

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
      "pub_date": "2026-10-10", "pub_year": 2026, "date_suspect": false,
      "sort_date": "2026-10-10", "oa_status": "gold", "pdf_url": "…", "cited_by_count": 0,
      "abstract": "…", "abstract_hash": "…", "abstract_source": "openalex", "abstract_missing": false,
      "directions": ["display"], "novelty_score": 5, "novelty_reason": "…",
      "innovation_zh": "…", "method_zh": "…", "keywords_zh": ["…"],
      "summary_source": "llm", "llm_model": "deepseek-chat", "llm_at": "…",
      "pending_summary": false, "first_seen": "…", "last_updated": "…"
    }
  ]
}
```

`docs/data/meta.json` 供页面使用：`project` / `generated_at` / `count` / `window_days` / `directions` / `highNoveltyThreshold` / `stats` / `source` / `summary_engine`。

## 5. 站点

- `docs/` 是 GitHub Pages 的根目录，**全部由 `src/site/` 生成**，不要手改。
- 两种形态：
  - `docs/index.html` + `docs/assets/*` + `docs/data/*.json` —— 线上版本，数据与代码分离；
  - `docs/standalone.html` —— 数据与代码全部内联的单文件版本，可离线分享。
- 内联 JSON 时把 `<` 转义成 `\u003c`，防止论文摘要里出现 `</script>` 截断脚本。
- 前端零依赖、零构建，全部文本经 `escapeHtml` 转义。
- 「已读」存 `localStorage['qd-paper-watch:read']`，因此每个人的已读状态互不干扰。
- 样式使用 CSS 变量 + `prefers-color-scheme` 自动深色，620px 以下单列。

## 6. 自动化

| 方式 | 触发 | 说明 |
| --- | --- | --- |
| GitHub Actions（`.github/workflows/update.yml`） | 每天 UTC 22:00（北京 06:00）或手动 | 先跑隐私自检与单测，再抓取渲染，只有 `docs/` 有变化才提交；key 来自仓库 Secret；`checkout` 用 `fetch-depth: 0` 以便扫全历史 |
| Windows 计划任务（`scripts/register-task.ps1`） | 每天指定时间 | 调用 `scripts/update.ps1`，日志写 `.tmp/update-YYYYMM.log`；可选 `-Push` |

抓取必须由 Node 发起（本机 PowerShell 环境可能无法建立 TLS）。PowerShell 脚本只负责调度与日志。

## 7. 测试

`npm test`（`node --test`，Node 自动发现 `test/*.test.mjs`）覆盖：

- `util`：DOI 规范化、标题归一化、日期计算、标签清洗、截断；
- `abstract`：倒排索引按 position 还原、Crossref JATS 清洗；
- `relevance`：六类判定路径（通过 / 碳点 / 标题无量子点 / 无器件信号 / 噪音 / 弱证据兜底）、`CdS` 不误判、带 `g` 正则的稳定性；
- `store`：记录生成、未来日期退回、摘要未变复用总结、摘要变化作废总结、预印本升级、重复条目合并、损坏文件抛错、原子写入；
- `llm`：缓存键、JSON 容错解析、字段归一化、无 key 跳过、命中缓存、真实请求体与鉴权头（注入假 fetch）、单篇失败不影响整轮；
- `privacy`：七条规则各自命中、白名单邮箱不误报、掩码不泄露原文、同行多处命中与行列号、正常内容（cron/长哈希/长数字/网址里的 `/home/`）不误报、非字符串输入、重复扫描一致、**仓库自己的源码通过自检**、`.gitignore` 必须包含密钥与缓存目录。

共 60 个用例。敏感串在测试里一律用拼接构造（`'sk-' + 'a1b…'`），否则测试文件自己会被隐私自检判为泄露。

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

