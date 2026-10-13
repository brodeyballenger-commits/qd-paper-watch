// site/app.js —— 零依赖前端。同时服务两种加载方式：
//   1) GitHub Pages：从 data/papers.json 和 data/meta.json 取数
//   2) standalone.html：数据已内联在 window.__PAPERS__ / window.__META__
(function () {
  'use strict';

  var READ_KEY = 'qd-paper-watch:read';

  var state = {
    papers: [],
    meta: {},
    query: '',
    directions: {},
    minNovelty: 0,
    rangeDays: 0,
    sort: 'date',
    hideRead: false,
    read: loadRead(),
  };

  var el = {};

  function loadRead() {
    try {
      var raw = localStorage.getItem(READ_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (e) {
      return {};
    }
  }

  function saveRead() {
    try {
      localStorage.setItem(READ_KEY, JSON.stringify(state.read));
    } catch (e) {
      /* 隐私模式下忽略 */
    }
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  function fetchJson(url) {
    return fetch(url, { cache: 'no-cache' }).then(function (res) {
      if (!res.ok) throw new Error(url + ' → HTTP ' + res.status);
      return res.json();
    });
  }

  function fmtDate(value) {
    if (!value) return '';
    var parts = String(value).slice(0, 10).split('-');
    if (parts.length !== 3) return value;
    return parts[0] + '年' + Number(parts[1]) + '月' + Number(parts[2]) + '日';
  }

  function daysAgo(value) {
    if (!value) return Infinity;
    var t = Date.parse(String(value).slice(0, 10) + 'T00:00:00');
    if (isNaN(t)) return Infinity;
    return (Date.now() - t) / 86400000;
  }

  function relativeLabel(value) {
    var d = daysAgo(value);
    if (d < 0) return '待上线';
    if (d < 1) return '今天';
    if (d < 2) return '昨天';
    if (d < 7) return Math.floor(d) + ' 天前';
    return '';
  }

  function directionMeta(id) {
    var list = (state.meta.directions || []).concat(state.meta.extraDirections || []);
    for (var i = 0; i < list.length; i += 1) {
      if (list[i].id === id) return list[i];
    }
    return { id: id, label: id, color: '#94a3b8' };
  }

  // OpenAlex 里不少摘要自带 "Abstract " 前缀，展示时去掉
  function cleanAbstract(text) {
    return String(text || '').replace(/^\s*abstract[\s:.\u2014\u2013-]+/i, '');
  }

  function paperText(paper) {
    return [
      paper.title,
      paper.title_zh,
      paper.abstract,
      paper.innovation_zh,
      paper.method_zh,
      paper.venue,
      (paper.keywords_zh || []).join(' '),
      (paper.authors || []).join(' '),
      paper.doi,
    ]
      .filter(Boolean)
      .join(' \n ')
      .toLowerCase();
  }

  function matches(paper) {
    if (state.query) {
      var terms = state.query.split(/\s+/).filter(Boolean);
      var text = paper.__text || (paper.__text = paperText(paper));
      for (var i = 0; i < terms.length; i += 1) {
        if (text.indexOf(terms[i]) === -1) return false;
      }
    }

    var dirIds = Object.keys(state.directions);
    if (dirIds.length) {
      var paperDirs = paper.directions || [];
      var hit = false;
      for (var j = 0; j < dirIds.length; j += 1) {
        if (paperDirs.indexOf(dirIds[j]) !== -1) {
          hit = true;
          break;
        }
      }
      if (!hit) return false;
    }

    if (state.minNovelty > 0) {
      if (!(Number(paper.novelty_score) >= state.minNovelty)) return false;
    }

    if (state.rangeDays > 0) {
      if (daysAgo(paper.sort_date || paper.pub_date) > state.rangeDays) return false;
    }

    if (state.hideRead && state.read[paper.doi]) return false;

    return true;
  }

  function sortPapers(list) {
    var copy = list.slice();
    copy.sort(function (a, b) {
      if (state.sort === 'novelty') {
        var diff = (b.novelty_score || 0) - (a.novelty_score || 0);
        if (diff !== 0) return diff;
      } else if (state.sort === 'citations') {
        var dc = (b.cited_by_count || 0) - (a.cited_by_count || 0);
        if (dc !== 0) return dc;
      }
      var dd = String(b.sort_date || '').localeCompare(String(a.sort_date || ''));
      if (dd !== 0) return dd;
      return String(b.first_seen || '').localeCompare(String(a.first_seen || ''));
    });
    return copy;
  }

  function noveltyBadge(paper) {
    var score = paper.novelty_score;
    if (!score) {
      return '<span class="badge badge-pending">创新度待评</span>';
    }
    var cls = score >= 5 ? 'badge-n5' : score >= 4 ? 'badge-n4' : score >= 3 ? 'badge-n3' : 'badge-n2';
    var reason = paper.novelty_reason ? ' title="' + escapeHtml(paper.novelty_reason) + '"' : '';
    return '<span class="badge ' + cls + '"' + reason + '>创新度 ' + score + '/5</span>';
  }

  function renderCard(paper) {
    var dirs = (paper.directions || [])
      .map(function (id) {
        var meta = directionMeta(id);
        return (
          '<span class="chip" style="--chip:' +
          escapeHtml(meta.color) +
          '">' +
          escapeHtml(meta.label) +
          '</span>'
        );
      })
      .join('');

    var keywords = (paper.keywords_zh || [])
      .map(function (k) {
        return '<span class="kw">' + escapeHtml(k) + '</span>';
      })
      .join('');

    var rel = relativeLabel(paper.sort_date || paper.pub_date);
    var isNew = daysAgo(paper.first_seen) < 1;
    var read = Boolean(state.read[paper.doi]);

    var summaryHtml;
    if (paper.innovation_zh) {
      summaryHtml =
        '<p class="innovation">' +
        escapeHtml(paper.innovation_zh) +
        '</p>' +
        (paper.method_zh ? '<p class="method"><span class="label">方法</span>' + escapeHtml(paper.method_zh) + '</p>' : '');
    } else if (paper.summary_source === 'failed') {
      summaryHtml = '<p class="pending">中文总结生成失败，下次更新会自动重试。</p>';
    } else {
      summaryHtml = '<p class="pending">中文总结待生成：在 .env 里填入 DEEPSEEK_API_KEY，再运行 npm run update 即可自动补齐（抓取本身不需要 key）。</p>';
    }

    var links = [];
    links.push('<a class="link" href="' + escapeHtml(paper.doi_url || 'https://doi.org/' + paper.doi) + '" target="_blank" rel="noopener">DOI 原文</a>');
    if (paper.pdf_url) {
      links.push('<a class="link" href="' + escapeHtml(paper.pdf_url) + '" target="_blank" rel="noopener">开放获取 PDF</a>');
    }

    // 这些平台没有开放接口（Google 学术明确禁止抓取、X-MOL 只有前端渲染的检索页），
    // 所以不能把它们的条目搬进本站，只能按标题一键跳到它们的站内检索。
    var q = encodeURIComponent(paper.title || paper.doi || '');
    var elsewhere = [
      ['Google 学术', 'https://scholar.google.com/scholar?q=' + q],
      ['X-MOL', 'https://www.x-mol.com/paper/search/q?option=' + q],
      ['百度学术', 'https://xueshu.baidu.com/s?wd=' + q],
    ]
      .map(function (pair) {
        return '<a href="' + escapeHtml(pair[1]) + '" target="_blank" rel="noopener">' + escapeHtml(pair[0]) + '</a>';
      })
      .join('');

    var abstractBlock = paper.abstract
      ? '<details class="abstract"><summary>查看英文摘要</summary><p>' + escapeHtml(cleanAbstract(paper.abstract)) + '</p></details>'
      : '<p class="muted small-text">数据库未收录摘要。</p>';

    var extra = [];
    if (paper.alt_doi) extra.push('同一论文的另一条记录：' + escapeHtml(paper.alt_doi));
    if (paper.date_suspect) extra.push('期刊给出的是未来出版日期，已按收录日期排序');

    return (
      '<article class="card' + (read ? ' is-read' : '') + '" data-doi="' + escapeHtml(paper.doi) + '">' +
      '<div class="card-head">' +
      '<h2 class="title-zh">' + escapeHtml(paper.title_zh || paper.title) + '</h2>' +
      '<button type="button" class="read-toggle" data-read="' + escapeHtml(paper.doi) + '" aria-pressed="' + (read ? 'true' : 'false') + '">' +
      (read ? '标为未读' : '标为已读') +
      '</button>' +
      '</div>' +
      (paper.title_zh ? '<p class="title-en">' + escapeHtml(paper.title) + '</p>' : '') +
      '<div class="meta-line">' +
      '<span class="venue">' + escapeHtml(paper.venue || '未知来源') + '</span>' +
      '<span class="dot">·</span><span>' + fmtDate(paper.pub_date) + '</span>' +
      (rel ? '<span class="dot">·</span><span class="rel">' + escapeHtml(rel) + '</span>' : '') +
      (isNew ? '<span class="badge badge-new">新收录</span>' : '') +
      (paper.oa_status === 'gold' || paper.oa_status === 'hybrid' || paper.oa_status === 'green'
        ? '<span class="badge badge-oa">开放获取</span>'
        : '') +
      '</div>' +
      '<div class="meta-line authors">' + escapeHtml((paper.authors || []).join('、')) + '</div>' +
      '<div class="tags">' + dirs + noveltyBadge(paper) + '</div>' +
      summaryHtml +
      (keywords ? '<div class="keywords">' + keywords + '</div>' : '') +
      abstractBlock +
      '<div class="card-foot">' + links.join('') +
      '<span class="search-links" title="按标题跳转到该平台的站内检索（它们不提供开放接口，无法把条目直接搬过来）">在别处查：' + elsewhere + '</span>' +
      (extra.length ? '<span class="extra">' + extra.join('；') + '</span>' : '') +
      '</div>' +
      '</article>'
    );
  }

  function render() {
    var filtered = state.papers.filter(matches);
    var sorted = sortPapers(filtered);

    el.list.innerHTML = sorted.map(renderCard).join('');
    el.empty.hidden = sorted.length > 0;
    el.hint.textContent = '显示 ' + sorted.length + ' / ' + state.papers.length + ' 篇';

    var unread = state.papers.filter(function (p) {
      return !state.read[p.doi];
    }).length;
    el.hint.textContent += ' · 未读 ' + unread + ' 篇';
  }

  function renderDirectionFilters() {
    var list = state.meta.directions || [];
    el.directionRow.innerHTML = list
      .map(function (d) {
        var count = state.papers.filter(function (p) {
          return (p.directions || []).indexOf(d.id) !== -1;
        }).length;
        return (
          '<button type="button" class="dir" data-dir="' +
          escapeHtml(d.id) +
          '" aria-pressed="false" style="--chip:' +
          escapeHtml(d.color) +
          '">' +
          escapeHtml(d.label) +
          ' <span class="dir-count">' +
          count +
          '</span></button>'
        );
      })
      .join('');
  }

  function renderHeader() {
    var meta = state.meta || {};
    el.statCount.textContent = '共 ' + state.papers.length + ' 篇';
    if (meta.generated_at) {
      var d = new Date(meta.generated_at);
      el.statUpdated.textContent =
        '更新于 ' +
        d.toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    }
    if (meta.project) {
      document.title = meta.project;
    }
    var windowDays = meta.window_days;
    el.subtitle.textContent = windowDays
      ? '自动追踪最近 ' + windowDays + ' 天内发表的量子点器件论文，并给出中文创新点总结。'
      : '自动追踪最新发表的量子点器件论文，并给出中文创新点总结。';
  }

  function bind() {
    el.q.addEventListener('input', function (e) {
      state.query = e.target.value.trim().toLowerCase();
      render();
    });

    el.sort.addEventListener('change', function (e) {
      state.sort = e.target.value;
      render();
    });

    el.range.addEventListener('change', function (e) {
      state.rangeDays = Number(e.target.value) || 0;
      render();
    });

    el.hideRead.addEventListener('change', function (e) {
      state.hideRead = e.target.checked;
      render();
    });

    el.onlyHigh.addEventListener('change', function (e) {
      state.minNovelty = e.target.checked ? state.meta.highNoveltyThreshold || 4 : 0;
      render();
    });

    el.reset.addEventListener('click', function () {
      state.query = '';
      state.directions = {};
      state.minNovelty = 0;
      state.rangeDays = 0;
      state.hideRead = false;
      el.q.value = '';
      el.range.value = '0';
      el.hideRead.checked = false;
      el.onlyHigh.checked = false;
      var buttons = el.directionRow.querySelectorAll('.dir');
      for (var i = 0; i < buttons.length; i += 1) buttons[i].setAttribute('aria-pressed', 'false');
      render();
    });

    el.directionRow.addEventListener('click', function (e) {
      var button = e.target.closest('.dir');
      if (!button) return;
      var id = button.getAttribute('data-dir');
      var pressed = button.getAttribute('aria-pressed') === 'true';
      button.setAttribute('aria-pressed', pressed ? 'false' : 'true');
      if (pressed) delete state.directions[id];
      else state.directions[id] = true;
      render();
    });

    el.list.addEventListener('click', function (e) {
      var button = e.target.closest('.read-toggle');
      if (!button) return;
      var doi = button.getAttribute('data-read');
      if (state.read[doi]) delete state.read[doi];
      else state.read[doi] = Date.now();
      saveRead();
      render();
    });
  }

  function fail(err) {
    el.error.hidden = false;
    el.errorDetail.textContent = err && err.message ? err.message : String(err);
    el.subtitle.textContent = '数据加载失败';
  }

  function boot() {
    el.q = document.getElementById('q');
    el.sort = document.getElementById('sort');
    el.range = document.getElementById('range');
    el.hideRead = document.getElementById('hide-read');
    el.onlyHigh = document.getElementById('only-high');
    el.reset = document.getElementById('reset');
    el.hint = document.getElementById('hint');
    el.list = document.getElementById('list');
    el.empty = document.getElementById('empty');
    el.error = document.getElementById('error');
    el.errorDetail = document.getElementById('error-detail');
    el.directionRow = document.getElementById('direction-row');
    el.statCount = document.getElementById('stat-count');
    el.statUpdated = document.getElementById('stat-updated');
    el.subtitle = document.getElementById('subtitle');

    var loading = null;
    if (window.__PAPERS__ && window.__META__) {
      loading = Promise.resolve({ papers: window.__PAPERS__, meta: window.__META__ });
    } else {
      loading = Promise.all([fetchJson('data/papers.json'), fetchJson('data/meta.json')]).then(function (res) {
        return { papers: res[0].papers || [], meta: res[1] };
      });
    }

    loading
      .then(function (data) {
        state.papers = data.papers || [];
        state.meta = data.meta || {};
        renderHeader();
        renderDirectionFilters();
        bind();
        render();
      })
      .catch(fail);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
