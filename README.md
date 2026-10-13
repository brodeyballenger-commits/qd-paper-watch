# qd-paper-watch · 量子点器件前沿追踪

每天自动抓取最新发表的**量子点（quantum dot）器件**论文，提取 DOI，调用 DeepSeek 根据摘要生成中文的「做了什么 / 创新在哪」，最后产出一个纯静态网站 —— 你可以随时打开看，也可以直接把网址发给同学。

- 固定网址（部署后）：`https://<你的GitHub用户名>.github.io/qd-paper-watch/`
- 不需要服务器、不需要数据库：数据是仓库里的 JSON 文件，页面是纯静态 HTML/JS
- 不需要安装任何 npm 依赖：全程只用 Node.js 自带的模块

---

## 1. 它是怎么工作的

```
OpenAlex API（按量子点主题 + 出版日期抓取）
        │  标题 / 摘要(倒排索引) / 期刊 / DOI / 作者 / 开放获取链接
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

**API key 永远不会进入浏览器**：DeepSeek 只在构建时（你的电脑或 GitHub Actions 里）被调用，页面里只有结果文本。

---

## 2. 环境准备

- Node.js **22 或更高**（`node -v` 检查）
- 想部署的话需要一个 GitHub 账号
- 想生成中文总结需要 DeepSeek 的 API key（<https://platform.deepseek.com/>）。**没有 key 也能正常运行**，只是卡片上会显示「中文总结待生成」。

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

底层 CLI 还支持：`--days=N`（窗口天数）、`--since=YYYY-MM-DD`、`--limit=N`（只处理前 N 篇，调试用）、`--llm-limit=N`（本轮最多只生成 N 篇中文总结，先花几分钱看质量）、`--quiet`。

> **花钱保护**：中文总结按 `提示词版本 + DOI + 摘要哈希` 缓存在 `.cache/llm-cache.json`（已 gitignore、不上线），
> 每 5 秒落盘一次。所以额度用完或中途 Ctrl+C，已经生成（已经付过钱）的总结不会丢，下次运行会自动复用，只补剩下的。

---

## 4. 部署到 GitHub Pages（让同学也能看）

```powershell
cd qd-paper-watch

# 1) 配置 git 身份（只需一次）
git config user.name  "你的名字"
git config user.email "你的邮箱"

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

然后在 GitHub 网页上做两件事：

1. **开启 Pages**：仓库 → `Settings` → `Pages` → Source 选 **Deploy from a branch** → 分支 `main`、目录 **`/docs`** → Save。
   一两分钟后访问 `https://<用户名>.github.io/qd-paper-watch/`。
2. **配置 DeepSeek key**（让云端也能生成中文总结）：仓库 → `Settings` → `Secrets and variables` → `Actions` → New repository secret，名字填 **`DEEPSEEK_API_KEY`**。
   （可选）再在 Variables 里加一个 `CONTACT_EMAIL`。

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
- **方向筛选**：显示与发光 / 光电探测与光伏 / 量子信息器件 / 材料与合成（可多选）
- **只看高创新**：创新度 ≥ 4 分的论文
- **时间范围**：全部 / 最近 7 天 / 30 天 / 90 天
- **排序**：按发表时间 / 创新度 / 被引用次数
- **已读标记**：点「标为已读」，可以「隐藏已读」。已读状态存在你自己浏览器的 localStorage 里，不影响别人
- **深色模式**：跟随系统
- **手机可用**：窄屏会自动变成单列

---

## 7. 目录结构

```
qd-paper-watch/
├── src/
│   ├── build.mjs          # 唯一入口：抓取 → 过滤 → 合并 → 总结 → 渲染
│   ├── config.mjs         # 主题、词表、噪音规则、方向定义（想调范围改这里）
│   ├── openalex.mjs       # OpenAlex 抓取（分页、字段选择、摘要还原）
│   ├── crossref.mjs       # Crossref 补摘要（OpenAlex 缺摘要时）
│   ├── relevance.mjs      # 相关性闸门（决定什么进站）
│   ├── store.mjs          # 主账本：去重、合并、原子写入
│   ├── llm.mjs            # DeepSeek 调用、结果缓存、并发控制
│   ├── prompt.mjs         # 提示词（改提示词记得同时改 PROMPT_VERSION）
│   ├── render.mjs         # 生成 docs/ 与 standalone.html
│   ├── abstract.mjs       # 摘要还原与清洗
│   ├── http.mjs           # 带重试的 fetch
│   ├── util.mjs           # 小工具
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
4. **站点零追踪**：页面没有第三方脚本、外部字体、统计代码，也没有作者名和联系方式；只有 OpenAlex 与 Crossref 两个「点了才走」的外链。
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

**Q：怎么把网站发给同学？**
发网址就行（`https://<用户名>.github.io/qd-paper-watch/`）。如果想离线分享，把 `docs/standalone.html` 这个单文件发过去，双击即可打开。
