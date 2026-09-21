import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TestClient, makeShape, startServer, statesEqual } from './helpers.js';

describe('按人隔离的撤销/重做', () => {
  let srv: Awaited<ReturnType<typeof startServer>>;
  const clients: TestClient[] = [];

  beforeEach(async () => {
    srv = await startServer();
  });
  afterEach(async () => {
    clients.forEach((c) => c.close());
    clients.length = 0;
    await srv.close();
  });

  const join = async (userId: string) => {
    const c = await TestClient.connect(srv.port, { userId });
    clients.push(c);
    return c;
  };

  it('撤销只回退本人那一步涉及的属性，他人对同图元的其它改动保留；重做同理', async () => {
    const a = await join('a');
    const b = await join('b');

    // a 创建图元（默认色），随后移动到 x=300
    const create = await a.op({ kind: 'shape.create', shape: makeShape('s1', 100, 100) });
    await a.waitSeq(create.seq!);
    const defaultColor = a.shapes.get('s1')!.color;
    const move = await a.op({ kind: 'shape.set', shapeId: 's1', attrs: { x: 300 } });
    // 这期间 b 改了同一图元的颜色
    const color = await b.op({ kind: 'shape.set', shapeId: 's1', attrs: { color: '#ff0000' } });
    await a.waitSeq(color.seq!);
    expect(a.shapes.get('s1')!.color).toBe('#ff0000');

    // a 撤销自己的"移动"那一步：只回退位置，b 改的颜色保留
    const undo1 = await a.undo();
    expect(undo1.acked).toBe(true);
    await a.waitSeq(undo1.seq!);
    expect(a.shapes.get('s1')!.x).toBe(100); // 位置回退
    expect(a.shapes.get('s1')!.color).toBe('#ff0000'); // b 的颜色改动保留

    // a 重做：位置恢复，颜色依旧不受影响
    const redo1 = await a.redo();
    expect(redo1.acked).toBe(true);
    await a.waitSeq(redo1.seq!);
    expect(a.shapes.get('s1')!.x).toBe(300);
    expect(a.shapes.get('s1')!.color).toBe('#ff0000');

    // b 撤销自己的改色：颜色回退，a 移动的位置保留
    const undoB = await b.undo();
    expect(undoB.acked).toBe(true);
    await b.waitSeq(undoB.seq!);
    await a.waitSeq(undoB.seq!);
    expect(b.shapes.get('s1')!.color).toBe(defaultColor);
    expect(b.shapes.get('s1')!.x).toBe(300);
    expect(statesEqual(a, b)).toBe(true);
  });

  it('撤销不会牵连他人操作：a 无法撤销 b 的改动', async () => {
    const a = await join('a');
    const b = await join('b');
    const r1 = await a.op({ kind: 'shape.create', shape: makeShape('sa', 10, 10) });
    const r2 = await b.op({ kind: 'shape.create', shape: makeShape('sb', 200, 200) });
    await a.waitSeq(r2.seq!);

    // a 撤销：只能撤销自己的创建，b 的图元不受影响
    const undoA = await a.undo();
    expect(undoA.acked).toBe(true);
    await a.waitSeq(undoA.seq!);
    expect(a.shapes.has('sa')).toBe(false);
    expect(a.shapes.has('sb')).toBe(true);

    // a 没有更多可撤销的操作了（b 的操作不在 a 的栈里）
    const again = await a.undo();
    expect(again.acked).toBe(false);
    expect(again.reason).toMatch(/没有可撤销/);
    expect(a.shapes.has('sb')).toBe(true);
    void r1;
  });

  it('撤销栈由服务端操作日志维护：断线重连后仍可续接撤销', async () => {
    const a = await join('a');
    const r1 = await a.op({ kind: 'shape.create', shape: makeShape('s1', 100, 100) });
    const r2 = await a.op({ kind: 'shape.set', shapeId: 's1', attrs: { x: 400 } });
    await a.waitSeq(r2.seq!);
    const lastSeq = r2.seq!;
    a.close();

    // 重连（带上 lastSeq 追增量），撤销栈仍在
    const a2 = await TestClient.connect(srv.port, { userId: 'a', lastSeq });
    clients.push(a2);
    expect(a2.shapes.get('s1')!.x).toBe(400);
    const undo = await a2.undo();
    expect(undo.acked).toBe(true);
    await a2.waitSeq(undo.seq!);
    expect(a2.shapes.get('s1')!.x).toBe(100);
    void r1;
  });

  it('撤销删除操作会完整恢复图元及其连线', async () => {
    const a = await join('a');
    await a.op({ kind: 'shape.create', shape: makeShape('s1', 100, 100) });
    await a.op({ kind: 'shape.create', shape: makeShape('s2', 400, 100) });
    const conn = await a.op({ kind: 'connector.create', id: 'c1', from: 's1', to: 's2' });
    await a.waitSeq(conn.seq!);
    expect(a.connectors.has('c1')).toBe(true);

    const del = await a.op({ kind: 'shape.delete', shapeId: 's1' });
    await a.waitSeq(del.seq!);
    expect(a.shapes.has('s1')).toBe(false);
    expect(a.connectors.has('c1')).toBe(false);

    const undo = await a.undo();
    expect(undo.acked).toBe(true);
    await a.waitSeq(undo.seq!);
    expect(a.shapes.has('s1')).toBe(true);
    expect(a.connectors.has('c1')).toBe(true);
    // 恢复后的连线端点重新贴合（s1 东边中点 = (100+120, 100+40)）
    const c = a.connectors.get('c1')!;
    expect(c.path[0]).toBe(220);
    expect(c.path[1]).toBe(140);
  });
});

describe('断线重连：快照 + 增量', () => {
  let srv: Awaited<ReturnType<typeof startServer>>;
  const clients: TestClient[] = [];

  beforeEach(async () => {
    srv = await startServer();
  });
  afterEach(async () => {
    clients.forEach((c) => c.close());
    clients.length = 0;
    await srv.close();
  });

  it('重连拿到完整快照并追上断线期间的增量，与他人一致', async () => {
    const a = await TestClient.connect(srv.port, { userId: 'a' });
    const b = await TestClient.connect(srv.port, { userId: 'b' });
    clients.push(a, b);

    const r1 = await a.op({ kind: 'shape.create', shape: makeShape('s1', 100, 100) });
    const r2 = await b.op({ kind: 'shape.set', shapeId: 's1', attrs: { color: '#00ff00' } });
    // a 收齐断线前的两条广播后记录 seq 与旧状态
    await a.waitSeq(r2.seq!);
    const lastSeq = r2.seq!;
    const staleShapes = structuredClone([...a.shapes.values()]);
    a.close();
    await new Promise((r) => setTimeout(r, 100));

    // 断线期间 b 又做了三条操作
    await b.op({ kind: 'shape.create', shape: makeShape('s2', 500, 100) });
    await b.op({ kind: 'shape.set', shapeId: 's1', attrs: { x: 300 } });
    await b.op({ kind: 'connector.create', id: 'c1', from: 's1', to: 's2' });

    // a 重连：带 lastSeq，应拿到快照 + 恰好 3 条增量
    const a2 = await TestClient.connect(srv.port, { userId: 'a', lastSeq });
    clients.push(a2);
    expect(a2.welcome.deltas).toHaveLength(3);
    expect(a2.welcome.deltas.map((d) => d.seq)).toEqual([lastSeq + 1, lastSeq + 2, lastSeq + 3]);
    expect(a2.welcome.snapshot.seq).toBe(lastSeq + 3);

    // 用增量在断线前的旧状态上重放 == 快照（不靠本地缓存拼凑）
    const replayed = new TestClient('replay');
    for (const s of staleShapes) replayed.shapes.set(s.id, s);
    for (const d of a2.welcome.deltas) replayed.applyEffects(d.forward);
    expect([...replayed.shapes.values()].sort((x, y) => x.id.localeCompare(y.id))).toEqual(
      [...a2.welcome.snapshot.shapes].sort((x, y) => x.id.localeCompare(y.id)),
    );

    // 与一直在线的 b 完全一致
    await b.waitSeq(lastSeq + 3);
    expect(statesEqual(a2, b)).toBe(true);
    void r1;
  });
});
