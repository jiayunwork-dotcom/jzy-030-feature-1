/**
 * 集成测试辅助：内存存储起真实服务器，ws 客户端模拟协作者。
 * TestClient 维护一份"客户端视角"的画布状态（应用 welcome 快照 + op 增量），
 * 用于断言多客户端收敛一致。
 */

import WebSocket from 'ws';
import { createServer } from '../src/index.js';
import { MemoryStore, type Store } from '../src/persistence/store.js';
import type {
  ClientMessage,
  Connector,
  Effects,
  Op,
  ServerMessage,
  Shape,
  Snapshot,
} from '../src/types.js';

export async function startServer(store: Store = new MemoryStore()) {
  const { server, wss, collab } = await createServer(store);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return {
    port,
    store,
    collab,
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of wss.clients) client.terminate();
        wss.close();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

let opCounter = 0;

export class TestClient {
  ws!: WebSocket;
  userId: string;
  welcome!: Extract<ServerMessage, { type: 'welcome' }>;
  messages: ServerMessage[] = [];
  shapes = new Map<string, Shape>();
  connectors = new Map<string, Connector>();
  lastSeq = 0;
  private waiters: { pred: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }[] = [];

  constructor(userId: string) {
    this.userId = userId;
  }

  static async connect(
    port: number,
    opts: { canvasId?: string; userId: string; name?: string; lastSeq?: number },
  ): Promise<TestClient> {
    const client = new TestClient(opts.userId);
    client.ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    client.ws.on('message', (raw) => client.onMessage(JSON.parse(String(raw)) as ServerMessage));
    await new Promise<void>((resolve, reject) => {
      client.ws.once('open', resolve);
      client.ws.once('error', reject);
    });
    const welcomePromise = client.waitFor((m) => m.type === 'welcome');
    client.send({
      type: 'hello',
      canvasId: opts.canvasId ?? 'main',
      userId: opts.userId,
      name: opts.name ?? opts.userId,
      lastSeq: opts.lastSeq,
    });
    client.welcome = (await welcomePromise) as Extract<ServerMessage, { type: 'welcome' }>;
    client.applySnapshot(client.welcome.snapshot);
    return client;
  }

  private onMessage(msg: ServerMessage) {
    this.messages.push(msg);
    if (msg.type === 'op') {
      this.applyEffects(msg.forward);
      this.lastSeq = Math.max(this.lastSeq, msg.seq);
    }
    for (let i = this.waiters.length - 1; i >= 0; i--) {
      if (this.waiters[i].pred(msg)) {
        const w = this.waiters[i];
        this.waiters.splice(i, 1);
        w.resolve(msg);
      }
    }
  }

  private applySnapshot(snap: Snapshot) {
    this.shapes.clear();
    this.connectors.clear();
    for (const s of snap.shapes) this.shapes.set(s.id, s);
    for (const c of snap.connectors) this.connectors.set(c.id, c);
  }

  applyEffects(fx: Effects) {
    for (const s of fx.upsertShapes ?? []) this.shapes.set(s.id, structuredClone(s));
    for (const p of fx.patchShapes ?? []) {
      const shape = this.shapes.get(p.id);
      if (shape) Object.assign(shape, p.attrs);
    }
    for (const id of fx.deleteShapeIds ?? []) this.shapes.delete(id);
    for (const c of fx.upsertConnectors ?? []) this.connectors.set(c.id, structuredClone(c));
    for (const id of fx.deleteConnectorIds ?? []) this.connectors.delete(id);
  }

  send(msg: ClientMessage) {
    this.ws.send(JSON.stringify(msg));
  }

  /** 发送操作并等待 ack（或 reject） */
  async op(op: Op): Promise<{ acked: boolean; seq?: number; reason?: string; msg: ServerMessage }> {
    const clientOpId = `c${++opCounter}`;
    const result = this.waitFor(
      (m) => (m.type === 'op.ack' || m.type === 'op.reject') && m.clientOpId === clientOpId,
    );
    this.send({ type: 'op', clientOpId, op });
    const msg = await result;
    if (msg.type === 'op.ack') return { acked: true, seq: msg.seq, msg };
    return { acked: false, reason: msg.reason, msg };
  }

  async undo(): Promise<{ acked: boolean; seq?: number; reason?: string }> {
    const clientOpId = `c${++opCounter}`;
    const result = this.waitFor(
      (m) => (m.type === 'op.ack' || m.type === 'op.reject') && m.clientOpId === clientOpId,
    );
    this.send({ type: 'undo', clientOpId });
    const msg = await result;
    return msg.type === 'op.ack' ? { acked: true, seq: msg.seq } : { acked: false, reason: msg.reason };
  }

  async redo(): Promise<{ acked: boolean; seq?: number; reason?: string }> {
    const clientOpId = `c${++opCounter}`;
    const result = this.waitFor(
      (m) => (m.type === 'op.ack' || m.type === 'op.reject') && m.clientOpId === clientOpId,
    );
    this.send({ type: 'redo', clientOpId });
    const msg = await result;
    return msg.type === 'op.ack' ? { acked: true, seq: msg.seq } : { acked: false, reason: msg.reason };
  }

  /** 等待客户端应用过 seq >= 指定值的广播（消除"ack 已到、广播未到"的竞态） */
  waitSeq(seq: number, timeoutMs = 3000): Promise<ServerMessage> {
    return this.waitFor((m) => m.type === 'op' && m.seq >= seq, timeoutMs);
  }

  waitFor(pred: (m: ServerMessage) => boolean, timeoutMs = 3000): Promise<ServerMessage> {
    const buffered = this.messages.find(pred);
    if (buffered) return Promise.resolve(buffered);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('waitFor 超时')), timeoutMs);
      this.waiters.push({
        pred,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
      });
    });
  }

  /** 等待一段时间，收集期间到达的消息（用于"不应收到"断言） */
  async quiet(ms: number): Promise<ServerMessage[]> {
    const before = this.messages.length;
    await new Promise((r) => setTimeout(r, ms));
    return this.messages.slice(before);
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

export function makeShape(id: string, x: number, y: number, w = 120, h = 80) {
  return { id, kind: 'rect' as const, x, y, w, h };
}

/** 深度比较两个客户端（或客户端与快照）的图元/连线状态 */
export function statesEqual(a: TestClient, b: TestClient): boolean {
  const sortShapes = (m: Map<string, Shape>) => [...m.values()].sort((x, y) => x.id.localeCompare(y.id));
  const sortConns = (m: Map<string, Connector>) => [...m.values()].sort((x, y) => x.id.localeCompare(y.id));
  return (
    JSON.stringify(sortShapes(a.shapes)) === JSON.stringify(sortShapes(b.shapes)) &&
    JSON.stringify(sortConns(a.connectors)) === JSON.stringify(sortConns(b.connectors))
  );
}
