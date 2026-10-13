# qd-paper-watch · 量子点器件前沿追踪

每天自动抓取最新发表的**量子点（quantum dot）器件**论文，提取 DOI，调用 DeepSeek 根据摘要生成中文的「做了什么 / 创新在哪」，最后产出一个纯静态网站 —— 你可以随时打开看，也可以直接把网址发给同学。

- 固定网址（部署后）：`https://<你的GitHub用户名>.github.io/qd-paper-watch/`
- 不需要服务器、不需要数据库：数据是仓库里的 JSON 文件，页面是纯静态 HTML/JS
- 不需要安装任何 npm 依赖：全程只用 Node.js 自带的模块

---

## 1. 它是怎么工作的

```
多源抓取（src/sources.mjs 统一调度，四个免费源 + 一个可选源）
        │  OpenAlex / Crossref / Semantic Scholar / arXiv（可选：Google 学术·SerpApi）
        │  标题 / 摘要 / 期刊 / DOI / 作者 / 开放获取链接 / 来源标记
        ▼
合并去重（src/sources.mjs 的 dedupeCandidates）
        │  同一篇论文可能被多个源同时发现 → 按 DOI 与标题归一化合并
        │  预印本 DOI 会让位给期刊 DOI（旧 DOI 记进 alt_doi），期刊名不会被「arXiv」盖住
        ▼
见刊闸门（src/published.mjs）
        │  只收「已经有正式期刊版本」的论文；arXiv 预印本必须能被解析出期刊 DOI 才入库
        │  判定依据：Crossref 的 type=journal-article、Semantic Scholar 的 journal/JournalArticle、
        │  OpenAlex 的 primary_location.source.type=journal；预印本 DOI/仓储名一律拒收
        ▼
摘要兜底（src/abstract-backfill.mjs）
        │  Crossref 常常不给摘要，没摘要就只能写「数据库未收录摘要」且只能给 1★
        │  用两个**批量**接口一次性补齐：Semantic Scholar /paper/batch（一次 500 篇）
        │  → OpenAlex /works?filter=doi:a|b|c（一次 50 篇，倒排索引还原）
        ▼
相关性闸门（src/relevance.mjs，确定性规则，纯本地、不花钱）
        │  必须同时满足：标题里有量子点证据 + 有器件/应用信号，且不踩噪音词
        ▼
去重与合并（src/store.mjs）
        │  按 DOI 合并；预印本升级成正式版时自动替换；摘要没变就复用已有中文总结
        ▼
DeepSeek（src/llm.mjs，可选）
        │  中文总结 + 创新点 + 方法 + 方向标签 + 创新度 1~5 分
        ▼
生成站点（src/render.mjs）
        │  docs/index.html + docs/assets/* + docs/data/*.json + docs/standalone.html
        ▼
GitHub Pages（自动更新）/ 本机预览（npm run preview）
```

### 数据源一览

| 源 | 是否默认启用 | 拿什么 | 见刊判定 |
| --- | --- | --- | --- |
| OpenAlex | ✅ | 主题命中 + 出版日期窗口，含摘要倒排索引、开放获取链接、被引数 | `primary_location.source.type === 'journal'` |
| Crossref | ✅ | 按标题相关度检索的期刊论文（`type:journal-article`），含 JATS 摘要与作者 | 它本身就是期刊论文登记库，取到即见刊 |
| Semantic Scholar | ✅ | 按关键词 bulk 检索（`publicationTypes=JournalArticle`）；**还负责把 arXiv 预印本解析成期刊版本** | `journal` 字段非空且类型为 JournalArticle |
| arXiv | ✅ | 预印本（`cond-mat.mtrl-sci` / `cond-mat.mes-hall` / `physics.app-ph` / `physics.optics`） | 必须经 Semantic Scholar 批量解析出期刊 DOI 才入库，否则丢弃；**只取窗口内提交的预印本**（arXiv 的短语检索会命中几年前的旧文） |
| Google 学术 | ⬜ 可选 | 走 SerpApi（`engine=google_scholar`，付费） | 用 Crossref 按标题回查，查到期刊论文才入库 |

- **不填 `SERPAPI_KEY` 就自动只用前四个免费源**，管线不会报错。
- Semantic Scholar 的 `SEMANTIC_SCHOLAR_API_KEY` 也是可选的：不填时匿名可用，只是限流更严、arXiv 解析更慢。
- 单源失败不会拖垮整轮：日志会写 `✗ 某某源 失败（其它源继续）`，只有全部源都失败才中止。
- **摘要兜底**：Crossref 这类登记库经常不给摘要，所以抓完后还会用两个批量接口补一次（Semantic Scholar `/paper/batch` 一次最多 500 个 DOI，OpenAlex `filter=doi:` 一次 50 个），日志写 `摘要兜底：缺 N 篇 → 补上 M 篇`。补不到的那些会在卡片上如实写「数据库未收录摘要，建议直接查看原文」。

**API key 永远不会进入浏览器**：DeepSeek / SerpApi / Semantic Scholar 的密钥只在构建时（你的电脑或 GitHub Actions 里）使用，页面里只有结果文本。

---

## 2. 环境准备

- Node.js **22 或更高**（`node -v` 检查）
- 想部署的话需要一个 GitHub 账号
- 想生成中文总结需要 DeepSeek 的 API key（<https://platform.deepseek.com/>）。**没有 key 也能正常运行**，只是卡片上会显示「中文总结待生成」。
- 抓取本身**不需要任何 key**：OpenAlex / Crossref / Semantic Scholar / arXiv 都是免费公开接口。想启用 Google 学术源才需要 SerpApi 的付费 key（见 `.env.example`）。

---

## 3. 首次使用（本机）

```powershell
cd qd-paper-watch

# 1) 填入你的 key（可选，但强烈建议）
#    编辑 .env，把 DEEPSEEK_API_KEY= 后面补上你的 key
#    CONTACT_EMAIL 建议填一个邮箱，这是 OpenAlex 的礼貌要求，能拿到更稳定的配额

# 2) 回填最近 90 天的论文，建立初版数据库
npm run backfill          # 等价于 node src/build.mjs --days=90

# 3) 本地预览
npm run preview           # 打开 http://127.0.0.1:5173/
```

`npm run preview` 会同时给出两个地址：

| 地址 | 用途 |
| --- | --- |
| `http://127.0.0.1:5173/` | 和 GitHub Pages 完全一致的版本（从 `docs/data/*.json` 取数） |
| `http://127.0.0.1:5173/standalone.html` | **单文件版**：数据已内联，可以直接把文件发给同学，双击就能看 |

常用命令：

| 命令 | 说明 |
| --- | --- |
| `npm run update` | 抓取最近 14 天并更新站点（日常用这个） |
| `npm run backfill` | 抓取最近 90 天（首次建库或长时间没跑之后用） |
| `npm run dry` | 只抓取和统计，不写文件、不调 LLM（省钱试跑） |
| `npm run no-llm` | 抓取并更新站点，但跳过 DeepSeek |
| `npm test` | 运行单元测试 |
| `npm run check:privacy` | 隐私自检：扫工作区，确认没有密钥/个人信息会被提交 |
| `npm run check:privacy:history` | 连全部提交历史一起扫（CI 每次都会跑这个） |

底层 CLI 还支持：

- `--days=N`（窗口天数）、`--since=YYYY-MM-DD`、`--limit=N`（只处理前 N 篇，调试用）、`--llm-limit=N`（本轮最多只生成 N 篇中文总结，先花几分钱看质量）、`--quiet`
- `--sources=openalex,crossref,semanticscholar,arxiv,scholar`：本轮只用指定的源（逗号分隔）。写错源名会直接报错并列出可用源；不写就用默认源（配了 `SERPAPI_KEY` 时自动加上 Google 学术）。例：`node src/build.mjs --days=7 --sources=arxiv,crossref`
- `--include-preprints`：**连同预印本一起收**（卡片上会标「预印本」徽章）。默认不开——默认只收已经见刊的论文，arXiv 预印本必须能解析出期刊版本才入库

> **花钱保护**：中文总结按 `提示词版本 + DOI + 摘要哈希` 缓存在 `.cache/llm-cache.json`（已 gitignore、不上线），
> 每 5 秒落盘一次。所以额度用完或中途 Ctrl+C，已经生成（已经付过钱）的总结不会丢，下次运行会自动复用，只补剩下的。

---

## 4. 部署到 GitHub Pages（让同学也能看）

```powershell
cd qd-paper-watch

# 1) 配置 git 身份（只需一次）
#    建议用 GitHub 的 noreply 邮箱，别把真实邮箱写进公开仓库的提交历史：
#    <账号ID>+<账号名>@users.noreply.github.com 里的两个值在
#    https://github.com/settings/emails 页面能看到（账号 ID 也在 gh api user 里）
git config user.name  "你的GitHub账号名"
git config user.email "你的账号ID+你的GitHub账号名@users.noreply.github.com"

# 2) 登录 GitHub（只需一次）
gh auth login

# 3) 首次提交（统一用 main 分支，Pages 配置里会用到）
git add -A
git commit -m "初始化：量子点器件论文追踪站"
git branch -M main

# 4) 建一个公开仓库并推送（`--push` 会把当前分支推上去）
gh repo create qd-paper-watch --public --source=. --remote=origin --push
```

> 检查一下 `.env` 没有被加进仓库：`git status --short` 里不应该出现 `.env`（它已在 `.gitignore` 里）。
> 更省事的做法是先跑一遍 `npm run check:privacy`，它会替你把工作区扫一遍。

然后在 GitHub 网页上做两件事：

1. **开启 Pages**：仓库 → `Settings` → `Pages` → Source 选 **Deploy from a branch** → 分支 `main`、目录 **`/docs`** → Save。
   一两分钟后访问 `https://<用户名>.github.io/qd-paper-watch/`。
2. **配置 DeepSeek key**（让云端也能生成中文总结）：仓库 → `Settings` → `Secrets and variables` → `Actions` → New repository secret，名字填 **`DEEPSEEK_API_KEY`**。
   （可选）再在 Variables 里加一个 `CONTACT_EMAIL`。
   （可选）想启用 Google 学术源就加 Secret **`SERPAPI_KEY`**；想给 Semantic Scholar 提配额就加 **`SEMANTIC_SCHOLAR_API_KEY`**。两个都不加也能跑。

**仓库必须是公开的**：GitHub Pages 对私有仓库需要付费方案。公开仓库不包含任何密钥，可以放心。

之后网站会自动更新：每天 UTC 22:00（北京时间 06:00）GitHub Actions 会抓取一次并提交新的数据文件。想立刻更新，就去仓库的 `Actions` → 「更新论文列表」 → `Run workflow`（可以填 `days` 和 `no_llm`）。

---

## 5. 本机定时更新（可选）

如果不想依赖 GitHub Actions（比如想在本地生成后手动推送）：

```powershell
# 注册计划任务：每天 06:00 抓取并更新站点，不推送
pwsh -File scripts\register-task.ps1

# 每天 08:30 抓取，并自动提交推送 docs/
pwsh -File scripts\register-task.ps1 -Time 08:30 -Push

# 卸载
pwsh -File scripts\register-task.ps1 -Unregister
```

日志写在 `.tmp\update-YYYYMM.log`。

---

## 6. 页面上能做什么

- **搜索**：标题、英文摘要、中文总结、关键词、期刊、作者、DOI 都能搜
- **只看已见刊**：筛选行第一个勾选框「只看已见刊」**默认打开**（数据来自多个源，默认把还没正式见刊的预印本挡在外面）
- **主方向：量子点发光二极管（QD-LED）**：勾选框「只看量子点发光二极管」**默认打开**，打开时页面只显示 QD-LED 论文；取消勾选就回到全部量子点器件论文。这条规则是纯关键词判定（见 `src/config.mjs` 的 `QLED_STRONG_PATTERNS` / `QLED_SUPPORTING_PATTERNS`），不重新调用 AI、不删数据
- **收录来源**：每张卡片会写「收录来源：OpenAlex / Crossref / Semantic Scholar / arXiv」，让你知道这篇是从哪个库发现的；如果是预印本（只在 `--include-preprints` 模式下才会出现）会多一个橙色「预印本」徽章
- **方向筛选**：量子点发光二极管 / 显示与发光 / 光电探测与光伏 / 量子信息器件 / 材料与合成（可多选）
- **只看高创新**：创新度 ≥ 4 分的论文
- **时间范围**：全部 / 最近 7 天 / 30 天 / 90 天
- **排序**：按发表时间 / 创新度 / 被引用次数
- **已读标记**：点「标为已读」，可以「隐藏已读」。已读状态存在你自己浏览器的 localStorage 里，不影响别人
- **外链**：每张卡片有「DOI 原文」（直达出版社，走 doi.org 解析）、有免费全文时多一个「开放获取 PDF」，以及「在别处查：Google 学术 / X-MOL / 百度学术」——按标题跳到这些平台的站内检索，确认同一篇论文在里面的收录情况
- **重置筛选**：右上角「重置筛选」会清空搜索与筛选，并把「只看量子点发光二极管」与「只看已见刊」重新打开（恢复本站默认视角）
- **深色模式**：跟随系统
- **手机可用**：窄屏会自动变成单列

---

## 7. 目录结构

```
qd-paper-watch/
├── src/
│   ├── build.mjs          # 唯一入口：多源抓取 → 见刊闸门 → 摘要兜底 → 过滤 → 合并 → 主方向补标 → 总结 → 渲染
│   ├── config.mjs         # 主题、词表（含 QD-LED 主方向词表）、噪音规则、方向定义、多源常量（想调范围改这里）
│   ├── sources.mjs        # 多源调度：抓取、合并去重、单源失败隔离、--sources 解析
│   ├── openalex.mjs       # OpenAlex 抓取（分页、字段选择、摘要还原）
│   ├── crossref-works.mjs # Crossref 检索期刊论文（多源之一）
│   ├── semanticscholar.mjs# Semantic Scholar bulk 检索 + 批量按 ID 查期刊版本
│   ├── arxiv.mjs          # arXiv Atom 解析 + 预印本→期刊版本解析
│   ├── scholar.mjs        # Google 学术（SerpApi，可选源）+ 标题相似度匹配
│   ├── published.mjs      # 见刊闸门：判断一篇论文是否已经有正式期刊版本
│   ├── abstract-backfill.mjs # 摘要兜底：批量从 Semantic Scholar / OpenAlex 补齐缺失摘要
│   ├── relevance.mjs      # 相关性闸门 + qledFocus/isQledDevice（决定什么进站、谁算 QD-LED）
│   ├── store.mjs          # 主账本：去重、合并、原子写入
│   ├── llm.mjs            # DeepSeek 调用、结果缓存、并发控制
│   ├── prompt.mjs         # 提示词（改提示词记得同时改 PROMPT_VERSION）
│   ├── render.mjs         # 生成 docs/ 与 standalone.html
│   ├── abstract.mjs       # 摘要还原与清洗
│   ├── http.mjs           # 带重试的 fetch（支持 GET/POST）
│   ├── util.mjs           # 小工具（含 normalizeText：把标题里的 Unicode 连字符折成 ASCII）
│   └── site/              # 站点源码（会被拷贝进 docs/）
│       ├── index.html
│       ├── app.js
│       └── style.css
├── docs/                  # ← GitHub Pages 的根目录（自动生成，不要手改）
│   ├── index.html
│   ├── standalone.html
│   ├── assets/
│   └── data/{papers.json, meta.json}
├── test/                  # node --test 单元测试
├── scripts/
│   ├── serve.mjs          # 本地预览服务器
│   ├── update.ps1         # 本机更新脚本（供计划任务调用）
│   └── register-task.ps1  # 注册/卸载 Windows 计划任务
├── .github/workflows/update.yml   # 每天自动更新 + 提交
├── specs/design.md        # 设计说明
├── .env                   # 你的密钥（已被 .gitignore 忽略）
└── .env.example
```

---

## 8. 隐私与身份保护

这个站是公开的，所以默认按「什么都不会泄露」来配置。已经生效的五条保障：

1. **密钥永不进仓库**：`.env`（放 key）、`.cache/`（放花钱买来的总结缓存）、`.tmp/`（日志）都在 `.gitignore` 里。
   GitHub Actions 里 key 只以 **Secret** 形式存在，打日志时自动变成 `***`；网站是纯静态页面，浏览器里没有 key，也没有后端。
2. **提交身份是 noreply 邮箱**：历史里每个提交都是
   `<账号ID>+<账号名>@users.noreply.github.com` 这种 GitHub 提供的免回复地址，没有真实邮箱。
   （当前仓库的提交身份可以用 `git log -1 --format='%an <%ae>'` 查看。）
3. **自带隐私自检兜底**：`src/privacy.mjs` + `scripts/check-privacy.mjs` 会扫 7 类东西 ——
   `sk-` 密钥、`ghp_` 之类的 GitHub 令牌、`Bearer` 请求头、手机号、身份证号、本机路径（`C:\Users\...`、`/home/...`）、私人邮箱。
   白名单只放 `example.com`、`github.com`、`users.noreply.github.com`、`deepseek.com`、`openalex.org`、`crossref.org`、`doi.org` 这类公共域名。
   命中时**只打印掩码**（`***@qq.com`、`sk***`），所以即使 CI 失败，公开的 Actions 日志里也不会出现原文。
4. **站点零追踪**：页面没有第三方脚本、外部字体、统计代码，也没有作者名和联系方式；外链只有「点了才走」的两类——指向论文原文的 DOI / 开放获取 PDF，以及「在别处查」的三个检索跳转（Google 学术 / X-MOL / 百度学术）。
5. **CI 每次把关**：`.github/workflows/update.yml` 第一步就 `node scripts/check-privacy.mjs --history`
   （用 `fetch-depth: 0` 拉完整历史），一旦扫出密钥或个人信息就直接失败、不发布。

想自己再确认一遍：

```powershell
npm run check:privacy            # 扫工作区（会跳过 .env，它本来就只在你本机）
npm run check:privacy:history    # 扫全部提交历史（历史上出现过的 .env 也会被扫出来）
```

### 身份匿名档位（按需选择）

上面的配置解决的是「仓库内容泄露」。如果你还想把「论文站 → 托管账号 → 更广的网络身份」这条链也断开，有三档可选：

| 档位 | 做法 | 代价 |
| --- | --- | --- |
| **A. 保持现状**（已经是当前状态） | 提交身份是 noreply、仓库内容无个人信息、页面零追踪 | 成本为零；但托管账号本身的公开资料、其他公开仓库仍可能被联想到你 |
| **B. 重写历史为中性身份** | `git filter-repo` 改掉提交者姓名/邮箱后 `git push --force` | 会重写公开历史；若已有人克隆需重新克隆 |
| **C. 换匿名账号托管** | 新建一个匿名 GitHub 账号，把这个仓库（内容本身干净）推过去 | 需要另建账号；旧仓库要删掉或转私有 |

另外，如果**托管账号下还有别的公开仓库带有真实姓名/邮箱**，链路 A 的「其他公开仓库」就会真的连到你身上 ——
建议把这些仓库改成 private，或把里面的联系方式换成 noreply 邮箱。

---

## 9. 常见问题

**Q：为什么页面默认只看「量子点发光二极管」？我不想限制怎么办？**
你这个项目的主方向就是 QD-LED，所以筛选行第一个勾选框默认打开（当前命中 63 篇）。**取消勾选**即可看到全部 270 篇量子点器件论文；点「重置筛选」会恢复默认（重新打开）。判定规则在 `src/config.mjs`：
- `QLED_STRONG_PATTERNS`：命中任意一条即算 QD-LED（`QD-LED` / `Q-LED` / `quantum dot light-emitting` / `light-emitting diodes` / `electroluminescence`）；
- `QLED_SUPPORTING_PATTERNS`：只做辅助，**必须至少两条同时命中**（裸 `LED` ＋ `microdisplay`／发光指标／器件叠层关键词）。这条「两条」的限制是为了挡住「用 LED 灯照射样品」的光电探测/光伏论文——实测这类论文摘要里真的会出现 LED 字样。
- 标签由**确定性关键词规则**给出（在 `src/build.mjs` 步骤「4.5 主方向标签」对全账本补标，幂等、只增不减），不依赖 AI，也不改动已有的中文总结，所以补标不会花钱。

**Q：为什么加了 arXiv、Semantic Scholar 这些源？它们不是预印本平台吗？**
你的要求是「论文需要已经见刊」，所以：arXiv 只用来**发现**新论文，每一条都拿去 Semantic Scholar 批量查询「这篇预印本有没有对应的期刊版本」；查到期刊 DOI 才入库（DOI 用期刊的那个，预印本 DOI 记进 `alt_doi`），查不到直接丢弃。Semantic Scholar 与 Crossref 两条线本身就带 `JournalArticle` / `journal-article` 过滤。想连预印本一起看，可以手动跑 `node src/build.mjs --days=14 --include-preprints`。

**Q：四个源会不会把同一篇论文收进来四次？**
不会。合并去重按 **DOI 相同**或**标题归一化后完全相同**两个条件合并成一条，`sources` 字段记下它被哪些源发现过（卡片上会显示「收录来源」）。预印本 DOI 会让位给期刊 DOI，所以不会出现「arXiv 版本盖掉期刊版本」的情况。

**Q：某个源挂了/限流了会不会整轮失败？**
不会。每个源独立抓取，失败只在日志里写一行 `✗ 某某源 失败（其它源继续）`；只有四个源全部失败才中止本轮。Semantic Scholar 匿名使用时偶尔会 429，重试几次拿不到就跳过，不影响其它源。

**Q：没有 API key 会怎样？**
抓取、过滤、网站都正常工作，只是卡片上写着「中文总结待生成」。之后填上 key 再 `npm run update`，所有待生成的论文会一次性补齐；已经生成过的不会重复花钱（按 `提示词版本 + DOI + 摘要哈希` 缓存）。

**Q：一次更新要花多少钱？**
每天新增约 3～5 篇论文需要总结，每篇输入约 1～2 千 token、输出几百 token。DeepSeek 的价格下一天不到 1 分钱。

**Q：摘要变了会不会漏掉新内容？**
不会。摘要哈希变了会自动作废旧总结并重新生成。

**Q：为什么有些论文没有摘要？**
OpenAlex 对部分期刊不收录摘要，这时脚本会再去 Crossref 补一次；仍然没有的话，卡片会提示「数据库未收录摘要」。这类论文只有在标题本身明确是量子点器件时才会被收录。

**Q：收录的论文太多/太少，或者跑偏了怎么办？**
调 `src/config.mjs`：`TOPIC_IDS` 控制抓取的主题范围；`QD_CORE_PATTERNS` / `DEVICE_PATTERNS` / `NOISE_PATTERNS` 控制闸门宽严。改动后可以先 `npm run dry` 看命中统计，再用 `.tmp/debug-relevance.mjs` 逐篇看判定原因。
（`PROMPT_VERSION` 改动会让所有论文的中文总结失效并重新生成，注意费用。）

**Q：数据会丢吗？**
`docs/data/papers.json` 只增不删，按 DOI 合并。写入用「临时文件 + rename」的原子方式，文件损坏时会直接报错拒绝覆盖，而不是静默清空。

**Q：论文在 Google 学术、X-MOL 这些平台上查得到吗？为什么不直接从它们那里抓？**
它们内部确实收录了这些论文（这些论文都有 DOI，属于正式发表的期刊论文），但**都不能作为数据源**：Google 学术没有公开接口，并且明确禁止程序抓取；X-MOL、百度学术的检索页是浏览器端渲染 + 反爬，没有可用的开放 API。所以本站的数据源是 OpenAlex（含 Crossref 补摘要），而每张卡片上提供「在别处查：Google 学术 / X-MOL / 百度学术」三个跳转，点开就是按该论文标题做的站内检索，用来核对收录情况或找中文页面。
如果要在浏览器里确认，注意 Google 学术、百度学术在部分网络下需要代理才能打开。

**Q：怎么把网站发给同学？**
发网址就行（`https://<用户名>.github.io/qd-paper-watch/`）。如果想离线分享，把 `docs/standalone.html` 这个单文件发过去，双击即可打开。
