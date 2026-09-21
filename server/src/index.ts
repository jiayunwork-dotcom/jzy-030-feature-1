/**
 * 服务器入口：HTTP（健康检查/快照查询）+ WebSocket（实时协作）。
 * DATABASE_URL 存在时使用 PostgreSQL 16 持久化，否则退化为内存存储（本地开发）。
 */

import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';
import { CollabServer } from './connection.js';
import { PgStore } from './persistence/pgStore.js';
import { MemoryStore, type Store } from './persistence/store.js';
import { buildSnapshot } from './snapshot.js';

const PORT = Number(process.env.PORT ?? 8080);

export async function createServer(store: Store) {
  const collab = new CollabServer(store);

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (url.pathname === '/api/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    const snapMatch = url.pathname.match(/^\/api\/canvases\/([\w-]+)\/snapshot$/);
    if (snapMatch && req.method === 'GET') {
      collab
        .getEngine(snapMatch[1])
        .then((engine) => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(buildSnapshot(engine)));
        })
        .catch((err) => {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: String(err) }));
        });
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (ws) => {
    void collab.handleConnection(ws);
  });

  return { server, wss, collab };
}

async function main() {
  let store: Store;
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl) {
    const pg = new PgStore(databaseUrl);
    // 容器编排下数据库可能尚未就绪，带重试初始化
    for (let attempt = 1; ; attempt++) {
      try {
        await pg.init();
        break;
      } catch (err) {
        if (attempt >= 30) throw err;
        console.log(`[server] 等待 PostgreSQL 就绪（第 ${attempt} 次）…`);
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    store = pg;
    console.log('[server] 使用 PostgreSQL 持久化');
  } else {
    store = new MemoryStore();
    console.log('[server] 未配置 DATABASE_URL，使用内存存储（重启不保留）');
  }

  const { server } = await createServer(store);
  server.listen(PORT, () => {
    console.log(`[server] HTTP+WS 已监听 :${PORT}（WS 路径 /ws）`);
  });
}

// 直接运行（非被测试 import）时启动
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
