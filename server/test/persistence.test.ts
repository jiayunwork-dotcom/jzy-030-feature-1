import { afterEach, describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/persistence/store.js';
import { TestClient, makeShape, startServer } from './helpers.js';

describe('持久化与重启恢复', () => {
  const servers: Awaited<ReturnType<typeof startServer>>[] = [];
  const clients: TestClient[] = [];

  afterEach(async () => {
    clients.forEach((c) => c.close());
    clients.length = 0;
    for (const s of servers.splice(0)) await s.close();
  });

  it('重启后画布内容、成员角色、定序与撤销栈全部从持久层恢复', async () => {
    const store = new MemoryStore(); // 与 PgStore 同一接口，语义等价

    // 第一台服务器：a(房主) 与 b 加入，b 被降级；a 创建、移动、撤销移动
    const srv1 = await startServer(store);
    servers.push(srv1);
    const a = await TestClient.connect(srv1.port, { userId: 'a' });
    const b = await TestClient.connect(srv1.port, { userId: 'b' });
    clients.push(a, b);
    a.send({ type: 'role.set', userId: 'b', role: 'viewer' });
    await b.waitFor((m) => m.type === 'role.changed');

    const r1 = await a.op({ kind: 'shape.create', shape: makeShape('s1', 100, 100) });
    const r2 = await a.op({ kind: 'shape.set', shapeId: 's1', attrs: { x: 500 } });
    const undo1 = await a.undo(); // 撤销移动 -> 回到 x=100
    expect(undo1.acked).toBe(true);
    await a.waitSeq(undo1.seq!);
    expect(a.shapes.get('s1')!.x).toBe(100);
    a.close();
    b.close();
    await srv1.close();
    servers.length = 0;

    // 第二台服务器：同一持久层，模拟重启
    const srv2 = await startServer(store);
    servers.push(srv2);
    const a2 = await TestClient.connect(srv2.port, { userId: 'a' });
    const b2 = await TestClient.connect(srv2.port, { userId: 'b' });
    clients.push(a2, b2);

    // 内容与定序恢复
    expect(a2.welcome.snapshot.shapes).toHaveLength(1);
    expect(a2.shapes.get('s1')!.x).toBe(100);
    expect(a2.welcome.seq).toBe(undo1.seq!);
    // 成员角色恢复（b 仍是只读）
    expect(b2.welcome.you.role).toBe('viewer');
    const rejected = await b2.op({ kind: 'shape.set', shapeId: 's1', attrs: { x: 1 } });
    expect(rejected.acked).toBe(false);

    // 撤销栈从操作日志重建：a 可以重做被撤销的移动
    const redo = await a2.redo();
    expect(redo.acked).toBe(true);
    await a2.waitSeq(redo.seq!);
    expect(a2.shapes.get('s1')!.x).toBe(500);

    // 也可以继续撤销更早的创建操作
    const undoCreate = await a2.undo(); // 撤销重做后的移动? 不——最新 normal 是移动
    expect(undoCreate.acked).toBe(true);
    await a2.waitSeq(undoCreate.seq!);
    expect(a2.shapes.get('s1')!.x).toBe(100);
    const undoCreate2 = await a2.undo(); // 撤销创建
    expect(undoCreate2.acked).toBe(true);
    await a2.waitSeq(undoCreate2.seq!);
    expect(a2.shapes.has('s1')).toBe(false);
    void r1;
    void r2;
  });
});
