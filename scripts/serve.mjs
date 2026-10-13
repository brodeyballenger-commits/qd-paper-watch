// scripts/serve.mjs —— 本地预览 docs/ 静态站点（零依赖）
// 用法：npm run preview   然后打开 http://127.0.0.1:5173/

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = path.join(ROOT, 'docs');
const PORT = Number(process.env.PORT || 5173);
const HOST = '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const server = http.createServer(async (req, res) => {
  try {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    let rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
    let target = path.join(DOCS, rel);

    // 防目录穿越
    if (!target.startsWith(DOCS)) {
      res.writeHead(403).end('403');
      return;
    }

    let stat = await fs.stat(target).catch(() => null);
    if (stat?.isDirectory()) {
      target = path.join(target, 'index.html');
      stat = await fs.stat(target).catch(() => null);
    }

    if (!stat) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 未找到（先运行 npm run update）');
      return;
    }

    const body = await fs.readFile(target);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end(String(err));
  }
});

server.listen(PORT, HOST, () => {
  console.log(`预览地址：http://${HOST}:${PORT}/`);
  console.log(`单文件版：http://${HOST}:${PORT}/standalone.html`);
});
