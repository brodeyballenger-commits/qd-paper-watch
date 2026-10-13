import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { isFutureDate, loadJson, makeRecord, mergeRecords, saveJsonAtomic } from '../src/store.mjs';

const NOW = '2026-10-13T00:00:00.000Z';
const LATER = '2026-10-20T00:00:00.000Z';

const raw = (over = {}) => ({
  doi: '10.1002/adma.202600001',
  doi_url: 'https://doi.org/10.1002/adma.202600001',
  title: 'Bright and Stable Quantum Dot Light-Emitting Diodes',
  abstract: 'We report quantum dot light-emitting diodes with 30% EQE.',
  pub_date: '2026-10-10',
  pub_year: 2026,
  venue: 'Advanced Materials',
  ...over,
});

test('isFutureDate 只看超过 30 天的「提前上线」日期', () => {
  const now = new Date(NOW);
  assert.equal(isFutureDate('2027-05-01', now), true);
  assert.equal(isFutureDate('2026-10-13', now), false);
  assert.equal(isFutureDate('2026-11-01', now), false);
  assert.equal(isFutureDate(null, now), false);
});

test('makeRecord 生成完整记录并计算摘要哈希', () => {
  const rec = makeRecord(raw(), { now: NOW, directions: ['display'], isPreprint: false });
  assert.equal(rec.id, '10.1002/adma.202600001');
  assert.equal(rec.sort_date, '2026-10-10');
  assert.equal(rec.date_suspect, false);
  assert.equal(rec.abstract_missing, false);
  assert.ok(rec.abstract_hash);
  assert.equal(rec.pending_summary, true);
  assert.equal(rec.alt_doi, null);
  assert.equal(rec.first_seen, NOW);
});

test('makeRecord 对未来出版日期退回首次发现时间，避免永久置顶', () => {
  const rec = makeRecord(raw({ pub_date: '2027-05-01' }), { now: NOW, directions: [] });
  assert.equal(rec.date_suspect, true);
  assert.equal(rec.sort_date, '2026-10-13');
});

test('makeRecord 无摘要时标记 abstract_missing', () => {
  const rec = makeRecord(raw({ abstract: null }), { now: NOW });
  assert.equal(rec.abstract, null);
  assert.equal(rec.abstract_hash, null);
  assert.equal(rec.abstract_missing, true);
});

test('mergeRecords 新增记录', () => {
  const { papers, stats } = mergeRecords([], [makeRecord(raw(), { now: NOW })], { now: NOW });
  assert.equal(stats.added, 1);
  assert.equal(stats.unchanged, 0);
  assert.equal(papers.length, 1);
});

test('mergeRecords 摘要未变时保留已生成的中文总结（不再花钱）', () => {
  const stored = makeRecord(raw(), { now: NOW, directions: ['display'] });
  stored.innovation_zh = '首次总结';
  stored.title_zh = '中文标题';
  stored.novelty_score = 5;
  stored.pending_summary = false;
  stored.summary_source = 'llm';
  stored.llm_model = 'deepseek-chat';

  const { papers, stats } = mergeRecords([stored], [makeRecord(raw(), { now: LATER, directions: ['display'] })], { now: LATER });

  assert.equal(stats.unchanged, 1);
  assert.equal(stats.updated, 0);
  assert.equal(papers[0].innovation_zh, '首次总结');
  assert.equal(papers[0].pending_summary, false);
  assert.equal(papers[0].first_seen, NOW);
  assert.equal(papers[0].last_updated, LATER);
});

test('mergeRecords 摘要变化时作废旧总结，等待重新生成', () => {
  const stored = makeRecord(raw(), { now: NOW, directions: ['display'] });
  stored.innovation_zh = '旧总结';
  stored.pending_summary = false;
  stored.summary_source = 'llm';

  const changed = raw({ abstract: 'Completely different abstract about quantum dot lasers.' });
  const { papers, stats } = mergeRecords([stored], [makeRecord(changed, { now: LATER, directions: ['display'] })], { now: LATER });

  assert.equal(stats.updated, 1);
  assert.equal(papers[0].pending_summary, true);
  assert.equal(papers[0].summary_source, null);
  assert.notEqual(papers[0].innovation_zh, '旧总结');
});

test('mergeRecords 正式版取代预印本：保留首次发现时间并记住旧 DOI', () => {
  const preprint = makeRecord(
    raw({ doi: '10.48550/arxiv.2601.00001', doi_url: 'https://doi.org/10.48550/arxiv.2601.00001', pub_date: '2026-09-20', venue: 'arXiv (Cornell University)' }),
    { now: NOW, directions: ['display'], isPreprint: true },
  );
  const journal = makeRecord(
    raw({ doi: '10.1002/adma.202600001', pub_date: '2026-10-10', venue: 'Advanced Materials' }),
    { now: LATER, directions: ['display'], isPreprint: false },
  );

  const { papers, stats } = mergeRecords([preprint], [journal], { now: LATER });

  assert.equal(stats.preprintMerged, 1);
  assert.equal(stats.added, 0);
  assert.equal(papers.length, 1);
  assert.equal(papers[0].doi, '10.1002/adma.202600001');
  assert.equal(papers[0].alt_doi, '10.48550/arxiv.2601.00001');
  assert.equal(papers[0].first_seen, NOW);
  assert.equal(papers[0].is_preprint, false);
});

test('mergeRecords 同标题不同 DOI 的重复期刊条目合并为一条', () => {
  const a = makeRecord(raw({ doi: '10.1002/a', title: 'Bright and Stable Quantum Dot Light-Emitting Diodes' }), { now: NOW });
  const b = makeRecord(raw({ doi: '10.1002/b', title: 'Bright and Stable Quantum Dot Light-Emitting Diodes!!' }), { now: LATER });
  const { papers, stats } = mergeRecords([a], [b], { now: LATER });
  assert.equal(stats.preprintMerged, 1);
  assert.equal(papers.length, 1);
  assert.equal(papers[0].doi, '10.1002/a');
  assert.equal(papers[0].alt_doi, '10.1002/b');
});

test('mergeRecords 按 sort_date 倒序排列', () => {
  const older = makeRecord(raw({ doi: '10.1/old', title: 'Older Work on Quantum Dot LEDs', pub_date: '2026-09-01' }), { now: NOW });
  const newer = makeRecord(raw({ doi: '10.1/new', title: 'Newer Work on Quantum Dot LEDs', pub_date: '2026-10-11' }), { now: NOW });
  const { papers } = mergeRecords([older], [newer], { now: NOW });
  assert.deepEqual(papers.map((p) => p.doi), ['10.1/new', '10.1/old']);
});

test('loadJson 对不存在的文件返回 fallback，对损坏文件抛错', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qd-store-'));
  const missing = path.join(dir, 'nope.json');
  assert.deepEqual(await loadJson(missing, { papers: [] }), { papers: [] });
  assert.equal(await loadJson(missing), null);

  const broken = path.join(dir, 'broken.json');
  await fs.writeFile(broken, '{ this is not json', 'utf8');
  await assert.rejects(() => loadJson(broken, {}), /数据文件已损坏/);
  await fs.rm(dir, { recursive: true, force: true });
});

test('saveJsonAtomic 写出的文件可以被 loadJson 读回，且不残留临时文件', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qd-store-'));
  const file = path.join(dir, 'papers.json');
  const value = { generated_at: NOW, papers: [makeRecord(raw(), { now: NOW })] };
  await saveJsonAtomic(file, value);

  const back = await loadJson(file);
  assert.equal(back.papers.length, 1);
  assert.equal(back.generated_at, NOW);

  const files = await fs.readdir(dir);
  assert.deepEqual(files, ['papers.json']);
  await fs.rm(dir, { recursive: true, force: true });
});
