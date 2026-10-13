import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanText, maskHit, PRIVACY_RULES, OK_EMAIL_DOMAINS } from '../src/privacy.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// 下面这些"敏感字符串"一律用拼接构造：
// 这样测试文件本身不会被隐私自检判为泄露（scripts/check-privacy.mjs 会扫到它）。
const AT = '@';
const KEY_LIKE = 'sk-' + 'a1b2c3d4e5f6g7h8i9j0k1';
const GH_TOKEN_LIKE = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6';
const BEARER_LIKE = 'Bearer ' + 'abcdefghijklmnopqrstuvwxyz012345';
const MOBILE_LIKE = '138' + '0013' + '8000';
const ID_LIKE = '110101' + '19900307' + '123X';
const PRIVATE_MAIL = 'someone' + AT + 'qq' + '.' + 'com';
const OK_MAIL = 'you' + AT + 'example' + '.' + 'com';
const WIN_PATH = 'C:' + '\\Users\\' + 'someuser' + '\\Desktop\\x.txt';
const NIX_PATH = '/home/' + 'someuser' + '/repo';
const MAC_PATH = '/Users/' + 'someuser' + '/repo';

const rulesOf = (text) => scanText(text).map((f) => f.rule);

test('每一条规则都能命中它该命中的东西', () => {
  assert.deepEqual(rulesOf(`DEEPSEEK_API_KEY=${KEY_LIKE}`), ['api-key']);
  assert.deepEqual(rulesOf(`token=${GH_TOKEN_LIKE}`), ['github-token']);
  assert.deepEqual(rulesOf(`Authorization: ${BEARER_LIKE}`), ['bearer']);
  assert.deepEqual(rulesOf(`联系方式 ${MOBILE_LIKE}`), ['cn-mobile']);
  assert.deepEqual(rulesOf(`证件 ${ID_LIKE}`), ['cn-id']);
  assert.deepEqual(rulesOf(`见 ${WIN_PATH}`), ['local-path']);
  assert.deepEqual(rulesOf(`见 ${NIX_PATH}`), ['local-path']);
  assert.deepEqual(rulesOf(`见 ${MAC_PATH}`), ['local-path']);
  assert.deepEqual(rulesOf(`发到 ${PRIVATE_MAIL} 即可`), ['personal-email']);
  assert.equal(PRIVACY_RULES.length, 7);
});

test('白名单域名（示例邮箱、GitHub 机器人邮箱）不算泄露', () => {
  assert.deepEqual(scanText(`联系 ${OK_MAIL}`), []);
  assert.deepEqual(scanText('提交者是 41898282+github-actions[bot]@users.noreply.github.com'), []);
  assert.deepEqual(scanText('文档里的默认值 you@example.org'), []);
  assert.ok(OK_EMAIL_DOMAINS.includes('example.com'));
});

test('命中的可打印形式不泄露原文（邮箱只留域名）', () => {
  const [hit] = scanText(`发到 ${PRIVATE_MAIL}`);
  assert.equal(hit.masked, '***' + AT + 'qq.com');
  assert.ok(!hit.masked.includes('someone'));

  const [key] = scanText(`key=${KEY_LIKE}`);
  assert.equal(key.masked, 'sk***');
  assert.ok(!key.masked.includes('a1b2c3d4'));
  assert.equal(maskHit('abc', 'api-key'), 'ab***');
});

test('同一行里的多处命中都会报出来，且行号列号可用', () => {
  const text = ['第一行没问题', `电话 ${MOBILE_LIKE}，邮箱 ${PRIVATE_MAIL}`].join('\n');
  const findings = scanText(text, { id: 'demo.md' });
  assert.equal(findings.length, 2);
  assert.deepEqual(findings.map((f) => f.rule).sort(), ['cn-mobile', 'personal-email']);
  for (const f of findings) {
    assert.equal(f.file, 'demo.md');
    assert.equal(f.line, 2);
    assert.ok(f.column > 1);
  }
});

test('常见正常内容不会误报', () => {
  const normal = [
    'cron: 0 22 * * *',
    '哈希 a3f9deadbeef0123456789012345678901234567abcdef',
    '订单号 123456789012345 只是长数字',
    '光波长 1550 nm，EQE 19.68%，EETA 光谱',
    'https://example.com/home/index.html 只是网址',
    'npm run check:privacy --history',
    'DOI 10.1021/acs.nanolett.6c03813',
  ];
  for (const line of normal) {
    assert.deepEqual(scanText(line), [], `不该命中：${line}`);
  }
});

test('文档里的省略写法（占位路径）不算泄露，但真路径必须报出来', () => {
  assert.deepEqual(scanText('会扫 ' + 'C:' + '\\' + 'Users' + '\\' + '... 这类写法'), []);
  assert.deepEqual(scanText('会扫 /home/' + '... 这类写法'), []);
  assert.deepEqual(scanText('会扫 /Users/' + '... 这类写法'), []);
  // 同一个规则在真路径上必须命中
  assert.deepEqual(rulesOf(`你机器上的 ${WIN_PATH}`), ['local-path']);
});

test('输入为空或非字符串也不会崩', () => {
  assert.deepEqual(scanText(''), []);
  assert.deepEqual(scanText(undefined), []);
  assert.deepEqual(scanText(null), []);
  assert.deepEqual(scanText(0), []);
});

test('重复扫描结果一致（g 标志的 lastIndex 不会污染判定）', () => {
  const text = `${PRIVATE_MAIL}\n${PRIVATE_MAIL}\n${MOBILE_LIKE}`;
  const a = scanText(text);
  const b = scanText(text);
  assert.deepEqual(a, b);
  assert.equal(a.length, 3);
});

test('仓库自己的源码与这个测试文件都通过自检', async () => {
  const files = ['../src/privacy.mjs', '../scripts/check-privacy.mjs', '../test/privacy.test.mjs'];
  for (const f of files) {
    const text = await fs.readFile(path.resolve(HERE, f), 'utf8');
    assert.deepEqual(scanText(text, { id: f }), [], `${f} 不该命中自己的规则`);
  }
});

test('.gitignore 一直盯着密钥、缓存与临时目录', async () => {
  const lines = (await fs.readFile(path.resolve(HERE, '../.gitignore'), 'utf8'))
    .split(/\r?\n/)
    .map((l) => l.trim());
  for (const needed of ['.env', '.env.local', '.cache/', '.tmp/']) {
    assert.ok(lines.includes(needed), `.gitignore 里缺少 ${needed}`);
  }
});
