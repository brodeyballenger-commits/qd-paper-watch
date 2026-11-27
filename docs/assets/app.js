    /**
     * =========================================================================
     * 全局配置区
     * =========================================================================
     * 数据全部来自本仓库的构建产物（GitHub Actions / 本机 npm run update 生成）：
     *   data/papers.json —— 已经过六源合并、去重、见刊闸门、相关性过滤、AI 中文总结
     *   data/meta.json   —— 统计、方向表、「本期必读」规则
     * 页面不再直连 OpenAlex：公开检索接口没有相关性过滤，会把无关论文和垃圾日期一起拉进来。
     */
    const CONFIG = {
      PAPERS_URL: 'data/papers.json',
      META_URL: 'data/meta.json',
      STORAGE_KEYS: {
        THEME: 'qd_watch_theme',
        STARRED: 'qd_watch_starred',
        READ: 'qd_watch_read',
        NOTES: 'qd_watch_notes'
      }
    };

    // 领域细分主题定义与自动打标正则
    const TOPIC_DEFINITIONS = [
      { id: 'all', label: '全部文献', regex: null },
      { id: 'qled', label: 'QLED 器件', regex: /\b(qled|qd-led|light-emitting diode|electroluminescen|eqe|external quantum efficiency)\b/i },
      { id: 'tandem', label: '串联/Tandem', regex: /\b(tandem|stacked|charge generation layer|cgl|interconnecting layer)\b/i },
      { id: 'htl', label: '空穴传输层 (HTL)', regex: /\b(htl|hole transport|ptaa|tfb|pvk|pedot|hole injection|hil|nio)\b/i },
      { id: 'etl', label: '电子传输层 (ZnMgO/ETL)', regex: /\b(etl|electron transport|znmgo|zno|electron injection|charge balance)\b/i },
      { id: 'stability', label: '稳定性/寿命', regex: /\b(stability|lifetime|t95|t50|operational|degradation|aging|shelf life)\b/i },
      { id: 'peqled', label: '钙钛矿量子点 (PeQLED)', regex: /\b(perovskite|peqled|cspbbr3|cspbi3|cspbx3|metal halide)\b/i },
      { id: 'top_journal', label: '顶刊精选', isTopJournalFilter: true }
    ];

    // 顶刊白名单匹配正则
    const TOP_JOURNAL_REGEX = /\b(nature|science|nature photonics|nature electronics|nature nanotechnology|nature communications|nature materials|science advances|advanced materials|advanced functional materials|nano letters|acs nano|joule|light: science & applications|angewandte chemie|journal of the american chemical society|matter)\b/i;

    // ==================== 应用全局状态 ====================
    const state = {
      papers: [],
      meta: {},
      mustRead: {},
      directions: [],
      renderLimit: 60,
      lastFilterSig: '',
      searchQuery: '',
      activeTopic: 'all',
      statusFilter: 'all', // 'all' | 'starred' | 'unread' | 'read'
      sortBy: 'date_desc', // 'date_desc' | 'citations_desc'
      starredIds: new Set(),
      readIds: new Set(),
      notes: {},           // { [paperId]: string }
      expandedAbstracts: new Set(),
      openNotes: new Set(),
      isLoading: false,
      currentCitationPaper: null
    };

    // ==================== 安全存储工具函数 ====================
    function loadFromStorage(key, fallback) {
      try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
      } catch (err) {
        return fallback;
      }
    }

    function saveToStorage(key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch (err) {
        console.warn('localStorage 写入受限:', err);
      }
    }

    // HTML 转义防止 XSS
    function escapeHtml(str) {
      if (str === null || str === undefined) return '';
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    // ==================== 主题初始化与切换 ====================
    function initTheme() {
      const savedTheme = loadFromStorage(CONFIG.STORAGE_KEYS.THEME, null);
      const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
      const useDark = savedTheme ? savedTheme === 'dark' : prefersDark;
      document.documentElement.classList.toggle('dark', useDark);
    }

    function toggleTheme() {
      const isDark = document.documentElement.classList.toggle('dark');
      saveToStorage(CONFIG.STORAGE_KEYS.THEME, isDark ? 'dark' : 'light');
      showToast(isDark ? '已切换至深色护眼模式' : '已切换至浅色学术模式');
    }

    // ==================== OpenAlex 数据解析与打标 ====================
    /**
     * 将 OpenAlex 的 abstract_inverted_index 还原为完整摘要文本
     */
    function reconstructAbstract(invertedIndex) {
      if (!invertedIndex || typeof invertedIndex !== 'object') return '';
      try {
        const pairs = [];
        for (const [word, positions] of Object.entries(invertedIndex)) {
          if (Array.isArray(positions)) {
            for (const pos of positions) {
              pairs.push([pos, word]);
            }
          }
        }
        if (pairs.length === 0) return '';
        pairs.sort((a, b) => a[0] - b[0]);
        return pairs.map(p => p[1]).join(' ').replace(/\s+/g, ' ').trim();
      } catch (e) {
        return '';
      }
    }

    /**
     * 自动提取论文所属的量子点细分方向标签
     */
    function extractTags(paper) {
      const text = `${paper.title || ''} ${paper.abstract || ''}`;
      const tags = [];
      for (const topic of TOPIC_DEFINITIONS) {
        if (topic.id === 'all' || topic.isTopJournalFilter) continue;
        if (topic.regex && topic.regex.test(text)) {
          tags.push({ id: topic.id, label: topic.label });
        }
      }
      return tags;
    }

    /**
     * 判断是否为领域顶刊
     */
    function isTopJournal(journalName) {
      if (!journalName) return false;
      return TOP_JOURNAL_REGEX.test(journalName);
    }

    /**
     * 缺摘要时模型会写一句套话（「数据库未收录摘要，建议直接查看原文。」）。
     * 这不是总结，不能当创新点展示，也不能在卡片上重复三遍。
     */
    function isRealSummary(text) {
      const s = (text || '').trim();
      if (!s) return false;
      return !/未收录摘要|建议直接查看原文|无法.{0,6}摘要|没有摘要|摘要未获取|无法获取摘要/.test(s);
    }

    /**
     * 规范化单条文献对象（兼容 OpenAlex API 与自定义本地 papers.json）
     */
    function normalizePaper(raw, idx = 0) {
      // 判断是否为 OpenAlex 原始结构
      if (raw && (raw.display_name || raw.authorships || raw.primary_location)) {
        const doiRaw = raw.doi || '';
        const doiUrl = doiRaw
          ? (doiRaw.startsWith('http') ? doiRaw : `https://doi.org/${doiRaw.replace(/^doi:/i, '')}`)
          : (raw.primary_location?.landing_page_url || raw.id || '');
        const authors = Array.isArray(raw.authorships)
          ? raw.authorships.map(a => a.author?.display_name).filter(Boolean)
          : [];
        const journal = raw.primary_location?.source?.display_name || 'Preprint / Journal';
        const date = raw.publication_date || (raw.publication_year ? `${raw.publication_year}-01-01` : '未知日期');
        const abstract = reconstructAbstract(raw.abstract_inverted_index);

        const paper = {
          id: raw.id || doiUrl || `oa-${idx}`,
          title: (raw.display_name || raw.title || 'Untitled Paper').replace(/<[^>]+>/g, ''),
          authors: authors.length ? authors : ['Unknown Authors'],
          journal,
          date,
          year: raw.publication_year || parseInt(date.slice(0, 4), 10) || new Date().getFullYear(),
          doi: doiUrl,
          citations: Number(raw.cited_by_count) || 0,
          isOA: Boolean(raw.open_access?.is_oa),
          oaUrl: raw.open_access?.oa_url || doiUrl,
          abstract
        };
        paper.isTop = isTopJournal(paper.journal);
        paper.tags = extractTags(paper);
        return paper;
      }

      // 兼容自定义 JSON 结构
      const doiStr = raw.doi || raw.url || raw.link || '';
      const doiUrl = doiStr
        ? (doiStr.startsWith('http') ? doiStr : `https://doi.org/${doiStr.replace(/^doi:/i, '')}`)
        : '';
      const dateStr = raw.date || raw.pub_date || raw.sort_date || raw.publication_date
        || (raw.year ? `${raw.year}-01-01` : '未知日期');
      const authorsArr = Array.isArray(raw.authors)
        ? raw.authors
        : (typeof raw.authors === 'string' ? raw.authors.split(/[,;]/).map(s => s.trim()).filter(Boolean) : ['Unknown Authors']);

      const paper = {
        id: raw.id || doiUrl || `local-${idx}-${(raw.title || '').slice(0, 12)}`,
        title: raw.title || 'Untitled Paper',
        authors: authorsArr,
        journal: raw.journal || raw.venue || 'Academic Journal',
        date: dateStr,
        year: raw.year || parseInt(dateStr.slice(0, 4), 10) || new Date().getFullYear(),
        doi: doiUrl,
        citations: Number(raw.citations ?? raw.cited_by_count) || 0,
        isOA: Boolean(raw.isOA || raw.open_access),
        oaUrl: raw.oaUrl || doiUrl,
        abstract: raw.abstract || ''
      };
      // 本项目 papers.json 独有的字段：中文标题、AI 总结、期刊指标、方向标签
      paper.title_zh = raw.title_zh || '';
      paper.innovation_zh = raw.innovation_zh || '';
      paper.method_zh = raw.method_zh || '';
      paper.keywords_zh = Array.isArray(raw.keywords_zh) ? raw.keywords_zh : [];
      paper.journal_if = typeof raw.journal_if === 'number' ? raw.journal_if : null;
      paper.journal_tier = raw.journal_tier || null;
      paper.directions = Array.isArray(raw.directions) ? raw.directions : [];
      paper.novelty_score = Number(raw.novelty_score) || 0;
      paper.novelty_reason = raw.novelty_reason || '';
      paper.is_preprint = Boolean(raw.is_preprint);
      paper.sources = Array.isArray(raw.sources) ? raw.sources : [];
      paper.pdf_url = raw.pdf_url || '';
      paper.first_seen = raw.first_seen || '';
      paper.sort_date = raw.sort_date || '';
      paper.date_suspect = Boolean(raw.date_suspect);
      paper.abstract_missing = Boolean(raw.abstract_missing);
      paper.title_zh ? paper.titleZh = paper.title_zh : null;
      // 期刊常把期号日期填到未来；这类记录按本站收录那天展示
      paper.display_date = (raw.date_suspect && raw.sort_date)
        ? raw.sort_date
        : (raw.pub_date || raw.sort_date || dateStr);
      paper.ai_summary = isRealSummary(paper.innovation_zh) ? paper.innovation_zh : '';
      paper.ai_method = isRealSummary(paper.method_zh) && paper.method_zh !== paper.innovation_zh ? paper.method_zh : '';

      paper.isTop = isTopJournal(paper.journal);
      paper.tags = extractTags(paper);
      return paper;
    }

    // ==================== 数据获取逻辑 ====================
    function setLoading(loading) {
      state.isLoading = loading;
      document.getElementById('loadingSkeleton').classList.toggle('hidden', !loading);
      document.getElementById('paperList').classList.toggle('hidden', loading);
      if (loading) {
        document.getElementById('emptyState').classList.add('hidden');
      }
    }

    function updateDataSourceBadge(text, colorClass = 'bg-emerald-500') {
      const badge = document.getElementById('dataSourceBadge');
      badge.innerHTML = `<span class="w-1.5 h-1.5 rounded-full ${colorClass} inline-block shrink-0"></span><span class="truncate">${escapeHtml(text)}</span>`;
    }

    /**
     * 读取构建产物 data/papers.json 与 data/meta.json
     * 这两个文件由本仓库的抓取管线生成，已做过相关性过滤与中文总结。
     */
    async function loadSiteData() {
      setLoading(true);
      updateDataSourceBadge('正在读取 data/papers.json...', 'bg-indigo-500 animate-pulse');
      try {
        // 单文件版（standalone.html）把数据内联成 window.__PAPERS__ / __META__，
        // 这样双击打开、或直接用 file:// 打开都能出数据 —— fetch 在 file:// 下会被 CORS 拦住。
        const inline = (typeof window !== 'undefined' && Array.isArray(window.__PAPERS__)) ? window.__PAPERS__ : null;
        const inlineMeta = (typeof window !== 'undefined' && window.__META__) ? window.__META__ : {};
        let list;
        if (inline) {
          list = inline;
          state.meta = inlineMeta || {};
        } else {
          const [papersRes, metaRes] = await Promise.all([
            fetch(CONFIG.PAPERS_URL, { cache: 'no-store' }),
            fetch(CONFIG.META_URL, { cache: 'no-store' }).catch(() => null)
          ]);
          if (!papersRes.ok) throw new Error('HTTP ' + papersRes.status);
          const json = await papersRes.json();
          list = Array.isArray(json) ? json : (Array.isArray(json.papers) ? json.papers : json.results);
          state.meta = {};
          if (metaRes && metaRes.ok) {
            try { state.meta = await metaRes.json(); } catch (e) { state.meta = {}; }
          }
        }
        if (!Array.isArray(list) || list.length === 0) throw new Error('JSON 里没有文献数组');

        state.mustRead = state.meta.must_read || {};
        state.directions = Array.isArray(state.meta.directions) ? state.meta.directions : [];

        state.papers = list.map((item, i) => normalizePaper(item, i));
        const generated = state.meta.generated_at ? new Date(state.meta.generated_at) : null;
        const stamp = generated
          ? `${String(generated.getMonth() + 1).padStart(2, '0')}/${String(generated.getDate()).padStart(2, '0')} ${String(generated.getHours()).padStart(2, '0')}:${String(generated.getMinutes()).padStart(2, '0')}`
          : '未知时间';
        updateDataSourceBadge(
          (inline ? '单文件版 · ' : '本地构建数据 · ') + state.papers.length + ' 篇 · 更新于 ' + stamp,
          'bg-emerald-500'
        );
        setLoading(false);
        renderAll();
        return true;
      } catch (err) {
        console.error('读取 data/papers.json 失败:', err);
        setLoading(false);
        state.papers = [];
        renderAll();
        const isFile = typeof location !== 'undefined' && location.protocol === 'file:';
        updateDataSourceBadge(isFile ? '本地文件模式读不到数据，请打开 standalone.html' : '未找到 data/papers.json，请先运行 npm run update', 'bg-rose-500');
        showToast(
          isFile
            ? '你现在是直接双击打开的 index.html，浏览器不允许它读同目录的 JSON。请改开 standalone.html，或用「打开网站.cmd」启动本地预览。'
            : '没有读到 data/papers.json，页面暂时无内容可展示',
          'warning'
        );
        return false;
      }
    }

    /**
     * 通过文件选择器导入本地 JSON
     */
    function handleLocalFileUpload(event) {
      const file = event.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const parsed = JSON.parse(e.target.result);
          const list = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.papers) ? parsed.papers : parsed.results);
          if (!Array.isArray(list) || list.length === 0) {
            throw new Error('未在 JSON 中找到文献数组');
          }
          state.papers = list.map((item, i) => normalizePaper(item, i));
          state.mustRead = {};
          updateDataSourceBadge(`已导入 ${file.name} (${state.papers.length} 篇)`, 'bg-indigo-500');
          showToast(`成功导入 ${state.papers.length} 篇文献`);
          renderAll();
        } catch (err) {
          showToast('JSON 文件解析失败，请检查文件格式', 'warning');
        }
      };
      reader.readAsText(file);
      event.target.value = '';
    }

    // ==================== 本期必读 ====================
    /**
     * 「本期必读」的归栏日期。
     * 期刊爱把期号日期填到未来（12-01、2027-01-01），直接拿它当锚点会把窗口整体推前，
     * 所以未来日期一律退回本站首次收录那天。
     */
    function entryDate(paper) {
      const today = new Date();
      const todayKey = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0');
      const sortKey = paper.sort_date || paper.date || '';
      if (!sortKey || sortKey === '未知日期') return paper.first_seen || '';
      if (sortKey > todayKey) return paper.first_seen || sortKey;
      return sortKey;
    }

    /**
     * 必读窗口的锚点取账本里最新的 first_seen，而不是浏览器当天：
     * 隔几天不开页面时，用当天当锚点会让整栏变空。
     */
    function mustReadCutoff() {
      const mr = state.mustRead || {};
      const days = mr.windowDays || 90;
      let anchor = '';
      for (const p of state.papers) {
        const d = p.first_seen || p.sort_date || '';
        if (d && d > anchor) anchor = d;
      }
      if (!anchor) return '';
      const t = new Date(anchor + 'T00:00:00Z');
      if (isNaN(t.getTime())) return '';
      t.setUTCDate(t.getUTCDate() - days);
      return t.toISOString().slice(0, 10);
    }

    function mustReadWhy(paper) {
      const raw = isRealSummary(paper.innovation_zh) ? paper.innovation_zh.trim() : '';
      if (raw) {
        const s = raw.length > 120 ? raw.slice(0, 120).replace(/[，。、；：,.;:]+$/, '') + '…' : raw;
        return s;
      }
      return '';
    }

    function renderMustRead() {
      const section = document.getElementById('mustReadSection');
      const listEl = document.getElementById('mustReadList');
      const noteEl = document.getElementById('mustReadNote');
      if (!section || !listEl) return;

      const mr = state.mustRead || {};
      const topMinIf = mr.topMinIf || 20;
      const fallbackMinIf = mr.fallbackMinIf || 15;
      const fallbackMinNovelty = mr.fallbackMinNovelty || 4;
      const limit = mr.limit || 6;
      const cutoff = mustReadCutoff();

      const recent = cutoff ? state.papers.filter(p => entryDate(p) >= cutoff) : state.papers.slice();
      const top = recent
        .filter(p => p.journal_tier === 1 && typeof p.journal_if === 'number' && p.journal_if >= topMinIf)
        .sort((a, b) => (b.journal_if - a.journal_if) || (b.novelty_score - a.novelty_score)
          || String(entryDate(b)).localeCompare(String(entryDate(a))));
      const chosen = top.slice(0, limit);
      const usedFallback = chosen.length < limit;
      if (chosen.length < limit) {
        const picked = new Set(chosen.map(p => p.id));
        const pool = recent
          .filter(p => !picked.has(p.id) && p.journal_tier === 1
            && typeof p.journal_if === 'number' && p.journal_if >= fallbackMinIf
            && p.novelty_score >= fallbackMinNovelty)
          .sort((a, b) => (b.novelty_score - a.novelty_score) || (b.journal_if - a.journal_if)
            || String(entryDate(b)).localeCompare(String(entryDate(a))));
        for (const p of pool) {
          if (chosen.length >= limit) break;
          chosen.push(p);
        }
      }

      if (chosen.length === 0) {
        section.classList.add('hidden');
        return;
      }
      section.classList.remove('hidden');

      const fillCount = chosen.length - top.slice(0, limit).length;
      const windowDays = mr.windowDays || 90;
      const bits = [];
      bits.push(`近 ${windowDays} 天 · 一区且 IF ≥ ${topMinIf} 的顶刊 ${top.slice(0, limit).length} 篇优先`);
      if (fillCount > 0) bits.push(`已用「一区 · IF ≥ ${fallbackMinIf} · 创新度 ≥ ${fallbackMinNovelty}」补足 ${fillCount} 篇`);
      bits.push('不受下方筛选影响');
      noteEl.textContent = bits.join(' · ');

      listEl.innerHTML = chosen.map((p, i) => {
        const isTop = i < top.slice(0, limit).length;
        const cap = isTop ? '顶刊' : '一区 · ' + (p.novelty_score || 0) + '/5';
        const capClass = isTop ? 'text-amber-600 dark:text-amber-400' : 'text-slate-400 dark:text-slate-500';
        const ifText = typeof p.journal_if === 'number' ? (Math.round(p.journal_if * 10) / 10).toFixed(1) : '—';
        const why = mustReadWhy(p);
        const title = p.title_zh || p.title;
        return `<li class="flex gap-3 px-4 py-3 transition-colors hover:bg-white/70 dark:hover:bg-slate-800/50">
          <span class="w-6 shrink-0 pt-0.5 text-[11px] font-mono font-semibold text-indigo-400 dark:text-indigo-400/80">${String(i + 1).padStart(2, '0')}</span>
          <div class="min-w-0 flex-1">
            <a href="${escapeHtml(p.doi || '#')}" target="_blank" rel="noopener" class="block text-sm font-semibold leading-snug text-slate-900 dark:text-white hover:text-indigo-700 dark:hover:text-indigo-300 line-clamp-2">${escapeHtml(title)}</a>
            <p class="mt-0.5 text-[11px] leading-relaxed text-slate-500 dark:text-slate-400 line-clamp-1">${escapeHtml(p.title)}</p>
            ${why ? `<p class="mt-1 text-xs leading-relaxed text-slate-600 dark:text-slate-300 line-clamp-2">${escapeHtml(why)}</p>` : ''}
          </div>
          <div class="w-24 shrink-0 text-right">
            <div class="font-mono text-base font-semibold text-indigo-600 dark:text-indigo-400">${escapeHtml(ifText)}</div>
            <div class="text-[11px] text-slate-500 dark:text-slate-400">${escapeHtml(p.journal)}</div>
            <div class="text-[11px] ${capClass}">${escapeHtml(cap)}</div>
          </div>
        </li>`;
      }).join('');
      if (window.lucide) lucide.createIcons();
    }

    // ==================== 筛选与排序引擎 ====================
    function getFilteredPapers() {
      const q = state.searchQuery.trim().toLowerCase();

      let list = state.papers.filter(paper => {
        // 1. 阅读状态筛选
        if (state.statusFilter === 'starred' && !state.starredIds.has(paper.id)) return false;
        if (state.statusFilter === 'read' && !state.readIds.has(paper.id)) return false;
        if (state.statusFilter === 'unread' && state.readIds.has(paper.id)) return false;

        // 2. 细分主题筛选
        if (state.activeTopic !== 'all') {
          if (state.activeTopic === 'top_journal') {
            if (!paper.isTop) return false;
          } else {
            const hasTag = paper.tags.some(t => t.id === state.activeTopic);
            if (!hasTag) return false;
          }
        }

        // 3. 关键词模糊匹配（标题、作者、期刊、摘要、个人笔记）
        if (q) {
          const noteText = (state.notes[paper.id] || '').toLowerCase();
          const haystack = [
            paper.title,
            paper.authors.join(' '),
            paper.journal,
            paper.abstract,
            noteText
          ].join(' ').toLowerCase();
          if (!haystack.includes(q)) return false;
        }

        return true;
      });

      // 4. 排序
      list.sort((a, b) => {
        if (state.sortBy === 'citations_desc') {
          return (b.citations - a.citations) || (b.date || '').localeCompare(a.date || '');
        }
        return (b.date || '').localeCompare(a.date || '');
      });

      return list;
    }

    // ==================== 渲染函数 ====================
    function renderAll() {
      renderMustRead();
      const sig = state.searchQuery + '|' + state.activeTopic + '|' + state.statusFilter + '|' + state.sortBy;
      if (sig !== state.lastFilterSig) {
        state.lastFilterSig = sig;
        state.renderLimit = 60;
      }
      renderStats();
      renderTopicPills();
      renderStatusButtons();
      renderPaperList();
      if (window.lucide) lucide.createIcons();
    }

    function renderStats() {
      const total = state.papers.length;
      const filteredCount = getFilteredPapers().length;
      const starredInCurrent = state.papers.filter(p => state.starredIds.has(p.id)).length;
      const readInCurrent = state.papers.filter(p => state.readIds.has(p.id)).length;
      const topJournalCount = state.papers.filter(p => p.isTop).length;
      const readPct = total > 0 ? Math.round((readInCurrent / total) * 100) : 0;

      document.getElementById('statTotal').textContent = total;
      document.getElementById('statFilteredHint').textContent = filteredCount !== total ? `篇（当前显示 ${filteredCount}）` : '篇';
      document.getElementById('statStarred').textContent = starredInCurrent;
      document.getElementById('statRead').textContent = readInCurrent;
      document.getElementById('statReadPct').textContent = `${readPct}%`;
      document.getElementById('statReadBar').style.width = `${readPct}%`;
      document.getElementById('statTopJournal').textContent = topJournalCount;
    }

    function renderTopicPills() {
      const container = document.getElementById('topicPillsContainer');
      container.innerHTML = TOPIC_DEFINITIONS.map(topic => {
        const isActive = state.activeTopic === topic.id;
        // 统计每个主题在当前库中的数量
        let count = state.papers.length;
        if (topic.id === 'top_journal') {
          count = state.papers.filter(p => p.isTop).length;
        } else if (topic.id !== 'all') {
          count = state.papers.filter(p => p.tags.some(t => t.id === topic.id)).length;
        }

        const activeClasses = 'bg-indigo-600 text-white border-indigo-600 dark:bg-indigo-500 dark:border-indigo-500 shadow-xs';
        const idleClasses = 'bg-slate-50 text-slate-600 border-slate-200/80 hover:bg-slate-100 hover:text-slate-900 dark:bg-slate-800/70 dark:text-slate-300 dark:border-slate-700/80 dark:hover:bg-slate-800';

        return `
          <button type="button" data-topic="${topic.id}" class="topic-pill-btn inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border transition-all cursor-pointer ${isActive ? activeClasses : idleClasses}">
            <span>${escapeHtml(topic.label)}</span>
            <span class="text-[10px] px-1.5 py-0.2 rounded-full ${isActive ? 'bg-white/20 text-white' : 'bg-slate-200/70 dark:bg-slate-700 text-slate-500 dark:text-slate-400'}">${count}</span>
          </button>
        `;
      }).join('');
    }

    function renderStatusButtons() {
      document.querySelectorAll('.status-filter-btn').forEach(btn => {
        const isActive = btn.dataset.status === state.statusFilter;
        btn.className = `status-filter-btn flex-1 sm:flex-none px-3 py-1.5 rounded-lg text-xs font-medium transition-all cursor-pointer ${
          isActive
            ? 'bg-white dark:bg-slate-900 text-indigo-600 dark:text-indigo-400 shadow-xs'
            : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
        }`;
      });
    }

    function formatAuthors(authors) {
      if (!authors || authors.length === 0) return 'Unknown Authors';
      if (authors.length <= 4) return authors.join(', ');
      return `${authors.slice(0, 4).join(', ')} et al. (${authors.length} 位作者)`;
    }

    function renderPaperList() {
      const listEl = document.getElementById('paperList');
      const emptyEl = document.getElementById('emptyState');
      const filtered = getFilteredPapers();

      if (filtered.length === 0) {
        listEl.innerHTML = '';
        if (!state.isLoading) emptyEl.classList.remove('hidden');
        return;
      }

      emptyEl.classList.add('hidden');
      const shown = filtered.slice(0, state.renderLimit);
      listEl.innerHTML = shown.map(paper => {
        const isStarred = state.starredIds.has(paper.id);
        const isRead = state.readIds.has(paper.id);
        const noteContent = state.notes[paper.id] || '';
        const hasNote = noteContent.trim().length > 0;
        const isAbstractExpanded = state.expandedAbstracts.has(paper.id);
        const isNoteOpen = state.openNotes.has(paper.id);
        const safeId = escapeHtml(paper.id);

        const journalBadgeClass = paper.isTop
          ? 'bg-violet-50 text-violet-700 border-violet-200/80 dark:bg-violet-950/60 dark:text-violet-300 dark:border-violet-800/70'
          : 'bg-slate-100 text-slate-700 border-slate-200/70 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700';

        const abstractHtml = paper.abstract
          ? `<div class="mt-3 text-xs sm:text-[13px] leading-relaxed text-slate-600 dark:text-slate-300 ${isAbstractExpanded ? '' : 'line-clamp-3'}">${escapeHtml(paper.abstract)}</div>
             <button type="button" data-action="toggle-abstract" data-id="${safeId}" class="mt-1.5 inline-flex items-center gap-1 text-xs font-medium text-indigo-600 dark:text-indigo-400 hover:underline cursor-pointer">
               <span>${isAbstractExpanded ? '收起摘要' : '展开完整摘要'}</span>
               <i data-lucide="${isAbstractExpanded ? 'chevron-up' : 'chevron-down'}" class="w-3.5 h-3.5"></i>
             </button>`
          : `<p class="mt-3 text-xs text-slate-400 dark:text-slate-500 italic">暂无公开摘要，可点击标题前往 DOI 原文查看。</p>`;

        const aiHtml = (paper.ai_summary || paper.ai_method || (paper.keywords_zh || []).length)
          ? `<div class="mt-3 rounded-xl bg-indigo-50/50 dark:bg-indigo-950/25 border border-indigo-100/70 dark:border-indigo-900/40 px-3 py-2.5">
               ${paper.ai_summary ? `<p class="text-[11px] font-semibold text-indigo-500 dark:text-indigo-400">创新点</p>
               <p class="mt-0.5 text-xs sm:text-[13px] leading-relaxed text-slate-700 dark:text-slate-200">${escapeHtml(paper.ai_summary)}</p>` : ''}
               ${paper.ai_method ? `<p class="mt-2 text-[11px] font-semibold text-slate-400 dark:text-slate-500">方法</p>
               <p class="mt-0.5 text-xs sm:text-[13px] leading-relaxed text-slate-600 dark:text-slate-300">${escapeHtml(paper.ai_method)}</p>` : ''}
               ${(paper.keywords_zh || []).length ? `<p class="mt-2 text-[11px] text-slate-400 dark:text-slate-500">关键词 · ${escapeHtml((paper.keywords_zh || []).join(' / '))}</p>` : ''}
             </div>`
          : '';

        const tagsHtml = paper.tags.length > 0
          ? `<div class="mt-3 flex flex-wrap gap-1.5">
               ${paper.tags.map(t => `<span class="px-2 py-0.5 rounded-md text-[11px] font-medium bg-indigo-50/70 text-indigo-700 dark:bg-indigo-950/40 dark:text-indigo-300 border border-indigo-100 dark:border-indigo-900/50">${escapeHtml(t.label)}</span>`).join('')}
             </div>`
          : '';

        return `
          <article class="group bg-white dark:bg-slate-900 rounded-2xl border ${isStarred ? 'border-amber-300/80 dark:border-amber-700/60' : 'border-slate-200/80 dark:border-slate-800'} p-4 sm:p-5 shadow-xs hover:shadow-md hover:border-indigo-200 dark:hover:border-slate-700 transition-all duration-200 ${isRead ? 'opacity-80' : ''}">
            <!-- 顶部元数据行 -->
            <div class="flex flex-wrap items-center justify-between gap-2 mb-2.5">
              <div class="flex flex-wrap items-center gap-2">
                <span class="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-lg text-xs font-semibold border ${journalBadgeClass}">
                  ${paper.isTop ? '<i data-lucide="sparkles" class="w-3 h-3"></i>' : ''}
                  <span>${escapeHtml(paper.journal)}</span>
                </span>
                <span class="inline-flex items-center gap-1 text-xs text-slate-500 dark:text-slate-400">
                  <i data-lucide="calendar" class="w-3.5 h-3.5 text-slate-400"></i>
                  <span>${escapeHtml(paper.display_date || paper.date)}</span>
                </span>
                <span class="inline-flex items-center gap-1 text-xs text-slate-500 dark:text-slate-400" title="被引用次数">
                  <i data-lucide="quote" class="w-3.5 h-3.5 text-slate-400"></i>
                  <span>${paper.citations} 引用</span>
                </span>
                ${paper.isOA ? `
                  <a href="${escapeHtml(paper.oaUrl || paper.doi)}" target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium bg-emerald-50 text-emerald-700 border border-emerald-200/70 dark:bg-emerald-950/50 dark:text-emerald-300 dark:border-emerald-800/60 hover:bg-emerald-100 transition-colors">
                    <i data-lucide="unlock" class="w-3 h-3"></i>
                    <span>Open Access</span>
                  </a>
                ` : ''}
              </div>

              ${isRead ? `
                <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-400">
                  <i data-lucide="check" class="w-3 h-3"></i>
                  <span>已读</span>
                </span>
              ` : ''}
            </div>

            <!-- 论文标题：AI 译好的中文标题在上，英文原标题在下 -->
            <h2 class="text-base sm:text-[17px] font-bold leading-snug text-slate-900 dark:text-white group-hover:text-indigo-600 dark:group-hover:text-indigo-400 transition-colors">
              ${paper.doi
                ? `<a href="${escapeHtml(paper.doi)}" target="_blank" rel="noopener noreferrer" class="hover:underline underline-offset-2">${escapeHtml(paper.title_zh || paper.title)}</a>`
                : escapeHtml(paper.title_zh || paper.title)
              }
            </h2>
            ${paper.title_zh ? `<p class="mt-1 text-xs sm:text-[13px] leading-relaxed text-slate-500 dark:text-slate-400">${escapeHtml(paper.title)}</p>` : ''}

            <!-- 作者列表 -->
            <p class="mt-1.5 text-xs sm:text-[13px] text-slate-500 dark:text-slate-400">
              ${escapeHtml(formatAuthors(paper.authors))}
            </p>

            ${aiHtml}

            <!-- 自动提取的细分领域标签 -->
            ${tagsHtml}

            <!-- 可展开摘要 -->
            ${abstractHtml}

            <!-- 底部科研操作栏 -->
            <div class="mt-4 pt-3.5 border-t border-slate-100 dark:border-slate-800/80 flex flex-wrap items-center justify-between gap-2">
              <div class="flex flex-wrap items-center gap-1.5 sm:gap-2">
                <!-- 收藏待读 -->
                <button type="button" data-action="toggle-star" data-id="${safeId}" class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium border transition-colors cursor-pointer ${
                  isStarred
                    ? 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/50 dark:text-amber-300 dark:border-amber-800'
                    : 'bg-white text-slate-600 border-slate-200/80 hover:bg-slate-50 dark:bg-slate-900 dark:text-slate-300 dark:border-slate-700/80 dark:hover:bg-slate-800'
                }">
                  <i data-lucide="star" class="w-3.5 h-3.5 ${isStarred ? 'fill-amber-400 text-amber-500' : ''}"></i>
                  <span>${isStarred ? '已收藏' : '收藏待读'}</span>
                </button>

                <!-- 标记已读 -->
                <button type="button" data-action="toggle-read" data-id="${safeId}" class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium border transition-colors cursor-pointer ${
                  isRead
                    ? 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/50 dark:text-emerald-300 dark:border-emerald-800'
                    : 'bg-white text-slate-600 border-slate-200/80 hover:bg-slate-50 dark:bg-slate-900 dark:text-slate-300 dark:border-slate-700/80 dark:hover:bg-slate-800'
                }">
                  <i data-lucide="check-circle-2" class="w-3.5 h-3.5"></i>
                  <span>${isRead ? '已读' : '标记已读'}</span>
                </button>

                <!-- 一键引用 -->
                <button type="button" data-action="open-citation" data-id="${safeId}" class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium bg-white text-slate-600 border border-slate-200/80 hover:bg-slate-50 dark:bg-slate-900 dark:text-slate-300 dark:border-slate-700/80 dark:hover:bg-slate-800 transition-colors cursor-pointer">
                  <i data-lucide="quote" class="w-3.5 h-3.5"></i>
                  <span>引用</span>
                </button>

                <!-- 科研笔记 -->
                <button type="button" data-action="toggle-note" data-id="${safeId}" class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium border transition-colors cursor-pointer ${
                  isNoteOpen || hasNote
                    ? 'bg-indigo-50 text-indigo-700 border-indigo-200 dark:bg-indigo-950/50 dark:text-indigo-300 dark:border-indigo-800'
                    : 'bg-white text-slate-600 border-slate-200/80 hover:bg-slate-50 dark:bg-slate-900 dark:text-slate-300 dark:border-slate-700/80 dark:hover:bg-slate-800'
                }">
                  <i data-lucide="notebook-pen" class="w-3.5 h-3.5"></i>
                  <span>笔记</span>
                  ${hasNote ? '<span class="w-1.5 h-1.5 rounded-full bg-indigo-500"></span>' : ''}
                </button>
              </div>

              <!-- 原文链接 -->
              ${paper.doi ? `
                <a href="${escapeHtml(paper.doi)}" target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-xl text-xs font-medium text-slate-500 hover:text-indigo-600 dark:text-slate-400 dark:hover:text-indigo-400 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors">
                  <span>DOI 原文</span>
                  <i data-lucide="external-link" class="w-3.5 h-3.5"></i>
                </a>
              ` : ''}
            </div>

            <!-- 可展开个人科研笔记区 -->
            ${isNoteOpen ? `
              <div class="mt-3.5 p-3.5 rounded-xl bg-slate-50 dark:bg-slate-950/70 border border-slate-200/80 dark:border-slate-800 space-y-2.5">
                <div class="flex flex-wrap items-center justify-between gap-2">
                  <span class="text-xs font-semibold text-slate-700 dark:text-slate-300 flex items-center gap-1.5">
                    <i data-lucide="pen-line" class="w-3.5 h-3.5 text-indigo-500"></i>
                    个人科研笔记（自动保存至浏览器本地）
                  </span>
                  <div class="flex flex-wrap items-center gap-1.5">
                    <button type="button" data-action="insert-template" data-id="${safeId}" data-tpl="器件结构: ITO / PEDOT:PSS / TFB / QDs / ZnMgO / Al\n" class="px-2 py-0.5 rounded-md text-[11px] bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:border-indigo-400 cursor-pointer">+ 器件结构</button>
                    <button type="button" data-action="insert-template" data-id="${safeId}" data-tpl="核心指标: EQE = %, Lmax = cd/m², T95@1000nit = h\n" class="px-2 py-0.5 rounded-md text-[11px] bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:border-indigo-400 cursor-pointer">+ EQE/寿命</button>
                    <button type="button" data-action="insert-template" data-id="${safeId}" data-tpl="核心创新点: \n" class="px-2 py-0.5 rounded-md text-[11px] bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:border-indigo-400 cursor-pointer">+ 创新点</button>
                  </div>
                </div>
                <textarea
                  data-note-input="${safeId}"
                  rows="3"
                  placeholder="记录这篇文献的器件结构、最高 EQE、亮度、T95 寿命或可借鉴的界面钝化思路..."
                  class="w-full p-3 rounded-xl text-xs sm:text-sm bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-slate-800 dark:text-slate-200 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-500 resize-y"
                >${escapeHtml(noteContent)}</textarea>
                <div class="flex items-center justify-between text-[11px] text-slate-400">
                  <span id="noteStatus-${safeId.replace(/[^a-zA-Z0-9_-]/g, '_')}">实时本地保存中</span>
                  <span>支持在顶部搜索栏中直接检索笔记内容</span>
                </div>
              </div>
            ` : ''}
          </article>
        `;
      }).join('') + (filtered.length > shown.length
        ? `<div class="pt-1 pb-2 text-center">
             <button type="button" data-action="load-more" class="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 border border-slate-200/80 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors cursor-pointer">
               <i data-lucide="chevron-down" class="w-4 h-4"></i>
               <span>再显示 60 篇（还有 ${filtered.length - shown.length} 篇）</span>
             </button>
           </div>`
        : '');
      if (window.lucide) lucide.createIcons();
    }

    // ==================== 引用格式化生成器 ====================
    function generateCitations(paper) {
      const authors = paper.authors && paper.authors.length ? paper.authors : ['Unknown'];
      const year = paper.year || (paper.date ? paper.date.slice(0, 4) : '2026');
      const doiClean = (paper.doi || '').replace(/^https?:\/\/(dx\.)?doi\.org\//i, '');

      // 1. GB/T 7714 格式
      const gbtAuthors = authors.length > 3
        ? `${authors.slice(0, 3).join(', ')}, 等`
        : authors.join(', ');
      const gbt = `${gbtAuthors}. ${paper.title}[J]. ${paper.journal}, ${year}.${doiClean ? ` DOI: ${doiClean}.` : ''}`;

      // 2. ACS / Nature 风格
      const acsAuthors = authors.length > 5
        ? `${authors.slice(0, 5).join('; ')}; et al.`
        : authors.join('; ');
      const acs = `${acsAuthors} ${paper.title}. ${paper.journal} ${year}.${doiClean ? ` https://doi.org/${doiClean}` : ''}`;

      // 3. BibTeX 格式
      const firstAuthorLast = (authors[0].split(/\s+/).pop() || 'author').replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
      const firstWord = (paper.title.split(/\s+/)[0] || 'qd').replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
      const citeKey = `${firstAuthorLast}${year}${firstWord}`;
      const bibtex = `@article{${citeKey},
  title     = {${paper.title}},
  author    = {${authors.join(' and ')}},
  journal   = {${paper.journal}},
  year      = {${year}},${doiClean ? `\n  doi       = {${doiClean}},` : ''}${paper.doi ? `\n  url       = {${paper.doi}}` : ''}
}`;

      return { gbt, acs, bibtex };
    }

    function openCitationModal(paperId) {
      const paper = state.papers.find(p => p.id === paperId);
      if (!paper) return;
      state.currentCitationPaper = paper;
      const { gbt, acs, bibtex } = generateCitations(paper);

      document.getElementById('citationModalTitle').textContent = paper.title;
      document.getElementById('citeGbtText').textContent = gbt;
      document.getElementById('citeAcsText').textContent = acs;
      document.getElementById('citeBibtexText').textContent = bibtex;

      document.getElementById('citationModal').classList.remove('hidden');
      if (window.lucide) lucide.createIcons();
    }

    // ==================== 剪贴板复制（兼容 iFrame 与 HTTPS） ====================
    function copyTextToClipboard(text) {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.setAttribute('readonly', '');
      textarea.style.position = 'fixed';
      textarea.style.top = '-9999px';
      document.body.appendChild(textarea);
      textarea.select();
      let success = false;
      try {
        success = document.execCommand('copy');
      } catch (err) {
        success = false;
      }
      document.body.removeChild(textarea);

      if (success) {
        showToast('引用格式已复制到剪贴板');
      } else if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text)
          .then(() => showToast('引用格式已复制到剪贴板'))
          .catch(() => showToast('复制失败，请手动选中文本复制', 'warning'));
      } else {
        showToast('复制失败，请手动选中文本复制', 'warning');
      }
    }

    // ==================== 导出中心（Markdown & BibTeX） ====================
    function openExportModal() {
      const starredCount = state.papers.filter(p => state.starredIds.has(p.id)).length;
      const filteredCount = getFilteredPapers().length;
      const allCount = state.papers.length;

      document.getElementById('exportCountStarred').textContent = `${starredCount} 篇`;
      document.getElementById('exportCountFiltered').textContent = `${filteredCount} 篇`;
      document.getElementById('exportCountAll').textContent = `${allCount} 篇`;

      // 如果收藏为 0，默认帮用户选中「当前筛选结果」提升体验
      const radios = document.querySelectorAll('input[name="exportScope"]');
      radios.forEach(r => {
        if (starredCount === 0 && r.value === 'filtered') r.checked = true;
        if (starredCount > 0 && r.value === 'starred') r.checked = true;
      });

      document.getElementById('exportModal').classList.remove('hidden');
      if (window.lucide) lucide.createIcons();
    }

    function getPapersForExport() {
      const scope = document.querySelector('input[name="exportScope"]:checked')?.value || 'filtered';
      if (scope === 'starred') return state.papers.filter(p => state.starredIds.has(p.id));
      if (scope === 'filtered') return getFilteredPapers();
      return state.papers;
    }

    function triggerFileDownload(filename, content, mimeType) {
      const blob = new Blob([content], { type: mimeType });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }

    function exportAsMarkdown() {
      const papers = getPapersForExport();
      if (papers.length === 0) {
        showToast('当前选择的导出范围为空，请先收藏文献或切换导出范围', 'warning');
        return;
      }
      const includeNotes = document.getElementById('exportIncludeNotes').checked;
      const dateStamp = new Date().toISOString().slice(0, 10);

      let md = `# QD Paper Watch 文献追踪导出\n\n`;
      md += `- **导出日期**：${dateStamp}\n`;
      md += `- **文献数量**：${papers.length} 篇\n\n---\n\n`;

      papers.forEach((p, idx) => {
        const note = (state.notes[p.id] || '').trim();
        const tagsStr = p.tags.map(t => `\`${t.label}\``).join(' ');
        md += `## ${idx + 1}. ${p.title}\n\n`;
        md += `- **期刊**：${p.journal} | **发表日期**：${p.date} | **引用**：${p.citations}\n`;
        md += `- **作者**：${p.authors.join(', ')}\n`;
        if (p.doi) md += `- **DOI**：${p.doi}\n`;
        if (tagsStr) md += `- **标签**：${tagsStr}\n`;
        if (p.abstract) md += `\n> **摘要**：${p.abstract}\n`;
        if (includeNotes && note) {
          md += `\n### 个人科研笔记\n${note}\n`;
        }
        md += `\n---\n\n`;
      });

      triggerFileDownload(`qd-papers-${dateStamp}.md`, md, 'text/markdown;charset=utf-8');
      document.getElementById('exportModal').classList.add('hidden');
      showToast(`已导出 ${papers.length} 篇文献至 Markdown 文件`);
    }

    function exportAsBibtex() {
      const papers = getPapersForExport();
      if (papers.length === 0) {
        showToast('当前选择的导出范围为空，请先收藏文献或切换导出范围', 'warning');
        return;
      }
      const dateStamp = new Date().toISOString().slice(0, 10);
      const bibContent = papers.map(p => generateCitations(p).bibtex).join('\n\n');
      triggerFileDownload(`qd-papers-${dateStamp}.bib`, bibContent, 'application/x-bibtex;charset=utf-8');
      document.getElementById('exportModal').classList.add('hidden');
      showToast(`已导出 ${papers.length} 篇文献至 BibTeX 文件`);
    }

    // ==================== Toast 轻提示 ====================
    function showToast(message, type = 'success') {
      const container = document.getElementById('toastContainer');
      const toast = document.createElement('div');
      const iconName = type === 'warning' ? 'alert-circle' : 'check-circle-2';
      const accentClass = type === 'warning'
        ? 'border-amber-300 dark:border-amber-700 text-amber-800 dark:text-amber-200'
        : 'border-emerald-300 dark:border-emerald-700 text-slate-800 dark:text-slate-100';
      const iconColor = type === 'warning' ? 'text-amber-500' : 'text-emerald-500';

      toast.className = `pointer-events-auto flex items-center gap-2 px-4 py-2.5 rounded-xl bg-white dark:bg-slate-900 border ${accentClass} shadow-lg text-xs sm:text-sm font-medium transition-all duration-300 translate-y-2 opacity-0`;
      toast.innerHTML = `<i data-lucide="${iconName}" class="w-4 h-4 ${iconColor} shrink-0"></i><span>${escapeHtml(message)}</span>`;

      container.appendChild(toast);
      if (window.lucide) lucide.createIcons();

      requestAnimationFrame(() => {
        toast.classList.remove('translate-y-2', 'opacity-0');
      });

      setTimeout(() => {
        toast.classList.add('translate-y-2', 'opacity-0');
        setTimeout(() => toast.remove(), 300);
      }, 2600);
    }

    // ==================== 事件监听绑定 ====================
    function bindEvents() {
      // 主题切换
      document.getElementById('themeToggleBtn').addEventListener('click', toggleTheme);

      // 同步/导入面板折叠
      const syncPanel = document.getElementById('syncPanel');
      document.getElementById('toggleSyncPanelBtn').addEventListener('click', () => {
        syncPanel.classList.toggle('hidden');
      });
      document.getElementById('closeSyncPanelBtn').addEventListener('click', () => {
        syncPanel.classList.add('hidden');
      });

      // 数据重载
      document.getElementById('reloadDataBtn').addEventListener('click', () => loadSiteData());

      // 本地 JSON 上传
      document.getElementById('localJsonFileInput').addEventListener('change', handleLocalFileUpload);

      // 本地实时过滤搜索
      const searchInput = document.getElementById('searchInput');
      const clearSearchBtn = document.getElementById('clearSearchBtn');
      searchInput.addEventListener('input', (e) => {
        state.searchQuery = e.target.value;
        clearSearchBtn.classList.toggle('hidden', !state.searchQuery);
        renderAll();
      });
      clearSearchBtn.addEventListener('click', () => {
        state.searchQuery = '';
        searchInput.value = '';
        clearSearchBtn.classList.add('hidden');
        renderAll();
      });

      // 状态筛选按钮
      document.querySelectorAll('.status-filter-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          state.statusFilter = btn.dataset.status;
          renderAll();
        });
      });

      // 排序选择
      document.getElementById('sortSelect').addEventListener('change', (e) => {
        state.sortBy = e.target.value;
        renderAll();
      });

      // 主题胶囊事件委托
      document.getElementById('topicPillsContainer').addEventListener('click', (e) => {
        const btn = e.target.closest('.topic-pill-btn');
        if (!btn) return;
        state.activeTopic = btn.dataset.topic;
        renderAll();
      });

      // 重置所有筛选
      document.getElementById('resetFiltersBtn').addEventListener('click', () => {
        state.searchQuery = '';
        state.activeTopic = 'all';
        state.statusFilter = 'all';
        searchInput.value = '';
        clearSearchBtn.classList.add('hidden');
        renderAll();
      });

      // 文献卡片内部操作事件委托
      const paperList = document.getElementById('paperList');
      paperList.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-action]');
        if (!btn) return;
        const action = btn.dataset.action;
        const id = btn.dataset.id;

        if (action === 'load-more') {
          state.renderLimit += 60;
          renderPaperList();
          if (window.lucide) lucide.createIcons();
          return;
        }

        if (action === 'toggle-star') {
          if (state.starredIds.has(id)) {
            state.starredIds.delete(id);
          } else {
            state.starredIds.add(id);
            showToast('已加入收藏待读');
          }
          saveToStorage(CONFIG.STORAGE_KEYS.STARRED, Array.from(state.starredIds));
          renderAll();
        } else if (action === 'toggle-read') {
          if (state.readIds.has(id)) {
            state.readIds.delete(id);
          } else {
            state.readIds.add(id);
          }
          saveToStorage(CONFIG.STORAGE_KEYS.READ, Array.from(state.readIds));
          renderAll();
        } else if (action === 'toggle-abstract') {
          if (state.expandedAbstracts.has(id)) {
            state.expandedAbstracts.delete(id);
          } else {
            state.expandedAbstracts.add(id);
          }
          renderPaperList();
          if (window.lucide) lucide.createIcons();
        } else if (action === 'toggle-note') {
          if (state.openNotes.has(id)) {
            state.openNotes.delete(id);
          } else {
            state.openNotes.add(id);
          }
          renderPaperList();
          if (window.lucide) lucide.createIcons();
        } else if (action === 'open-citation') {
          openCitationModal(id);
        } else if (action === 'insert-template') {
          const tpl = btn.dataset.tpl || '';
          const current = state.notes[id] || '';
          state.notes[id] = current ? `${current.trimEnd()}\n${tpl}` : tpl;
          saveToStorage(CONFIG.STORAGE_KEYS.NOTES, state.notes);
          renderPaperList();
          if (window.lucide) lucide.createIcons();
        }
      });

      // 个人笔记输入实时自动保存
      paperList.addEventListener('input', (e) => {
        const textarea = e.target.closest('textarea[data-note-input]');
        if (!textarea) return;
        const id = textarea.dataset.noteInput;
        state.notes[id] = textarea.value;
        saveToStorage(CONFIG.STORAGE_KEYS.NOTES, state.notes);
        const statusEl = document.getElementById(`noteStatus-${id.replace(/[^a-zA-Z0-9_-]/g, '_')}`);
        if (statusEl) {
          const timeStr = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
          statusEl.textContent = `已自动保存 (${timeStr})`;
        }
      });

      // 引用模态框事件
      const citationModal = document.getElementById('citationModal');
      document.getElementById('closeCitationModalBtn').addEventListener('click', () => citationModal.classList.add('hidden'));
      citationModal.addEventListener('click', (e) => {
        if (e.target === citationModal) citationModal.classList.add('hidden');
      });
      document.querySelectorAll('.copy-cite-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const targetEl = document.getElementById(btn.dataset.copyTarget);
          if (targetEl) copyTextToClipboard(targetEl.textContent);
        });
      });

      // 导出中心模态框事件
      const exportModal = document.getElementById('exportModal');
      document.getElementById('openExportBtn').addEventListener('click', openExportModal);
      document.getElementById('closeExportModalBtn').addEventListener('click', () => exportModal.classList.add('hidden'));
      exportModal.addEventListener('click', (e) => {
        if (e.target === exportModal) exportModal.classList.add('hidden');
      });
      document.getElementById('downloadMarkdownBtn').addEventListener('click', exportAsMarkdown);
      document.getElementById('downloadBibtexBtn').addEventListener('click', exportAsBibtex);

      // ESC 快捷键关闭模态框
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          citationModal.classList.add('hidden');
          exportModal.classList.add('hidden');
        }
      });
    }

    // ==================== 应用启动入口 ====================
    window.addEventListener('DOMContentLoaded', () => {
      initTheme();

      // 从 localStorage 恢复用户的收藏、已读和笔记状态
      state.starredIds = new Set(loadFromStorage(CONFIG.STORAGE_KEYS.STARRED, []));
      state.readIds = new Set(loadFromStorage(CONFIG.STORAGE_KEYS.READ, []));
      state.notes = loadFromStorage(CONFIG.STORAGE_KEYS.NOTES, {});

      bindEvents();
      if (window.lucide) lucide.createIcons();

      // 启动数据读取
      loadSiteData();
    });