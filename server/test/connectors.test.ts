import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TestClient, makeShape, startServer } from './helpers.js';

describe('连线重算与级联删除', () => {
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

  it('图元移动后连线端点贴合到最近锚点，路径随操作广播且可复现', async () => {
    const a = await join('a');
    const b = await join('b');
    // s1(100,100,120x80) 与 s2(400,100,120x80) 并排
    await a.op({ kind: 'shape.create', shape: makeShape('s1', 100, 100) });
    await a.op({ kind: 'shape.create', shape: makeShape('s2', 400, 100) });
    const conn = await a.op({ kind: 'connector.create', id: 'c1', from: 's1', to: 's2' });
    await a.waitSeq(conn.seq!);
    await b.waitSeq(conn.seq!);

    // 初始：s1 东边中点 (220,140) -> s2 西边中点 (400,140)
    let c = a.connectors.get('c1')!;
    expect(c.fromSide).toBe('e');
    expect(c.toSide).toBe('w');
    expect([c.path[0], c.path[1]]).toEqual([220, 140]);
    expect([c.path[c.path.length - 2], c.path[c.path.length - 1]]).toEqual([400, 140]);

    // 移动 s1 到 s2 下方：连线走向必须跟着重算，不能停在旧坐标
    const move = await a.op({ kind: 'shape.set', shapeId: 's1', attrs: { x: 400, y: 400 } });
    const rerouted = await b.waitFor(
      (m) => m.type === 'op' && m.seq === move.seq && (m.forward.upsertConnectors ?? []).length > 0,
    );
    expect(rerouted.type === 'op' && rerouted.forward.upsertConnectors![0].id).toBe('c1');
    await a.waitSeq(move.seq!);

    c = a.connectors.get('c1')!;
    // s1 现在在 (400,400)，s2 在 (400,100)：垂直排列，s1 顶边中点 (460,400)，s2 底边中点 (460,180)
    expect(c.fromSide).toBe('n');
    expect(c.toSide).toBe('s');
    expect([c.path[0], c.path[1]]).toEqual([460, 400]);
    expect([c.path[c.path.length - 2], c.path[c.path.length - 1]]).toEqual([460, 180]);
    expect(statesEqualShapes(a, b)).toBe(true);

    // 可复现：重连客户端从快照拿到的路径与在线客户端逐位一致
    const c2 = await join('c');
    const snap = c2.connectors.get('c1')!;
    expect(snap.path.join(',')).toBe(c.path.join(','));
    expect(snap.fromSide).toBe(c.fromSide);
    expect(snap.toSide).toBe(c.toSide);
  });

  it('缩放图元同样触发连线重算', async () => {
    const a = await join('a');
    await a.op({ kind: 'shape.create', shape: makeShape('s1', 100, 100) });
    await a.op({ kind: 'shape.create', shape: makeShape('s2', 400, 100) });
    await a.op({ kind: 'connector.create', id: 'c1', from: 's1', to: 's2' });
    const resize = await a.op({ kind: 'shape.set', shapeId: 's1', attrs: { w: 200 } });
    await a.waitSeq(resize.seq!);
    const c = a.connectors.get('c1')!;
    // s1 变宽后东边中点 x = 100+200 = 300
    expect([c.path[0], c.path[1]]).toEqual([300, 140]);
  });

  it('删除图元时挂在它上面的连线一并删除，不留悬空端点', async () => {
    const a = await join('a');
    const b = await join('b');
    await a.op({ kind: 'shape.create', shape: makeShape('s1', 100, 100) });
    await a.op({ kind: 'shape.create', shape: makeShape('s2', 400, 100) });
    await a.op({ kind: 'shape.create', shape: makeShape('s3', 250, 400) });
    await a.op({ kind: 'connector.create', id: 'c1', from: 's1', to: 's2' });
    await a.op({ kind: 'connector.create', id: 'c2', from: 's1', to: 's3' });
    await a.op({ kind: 'connector.create', id: 'c3', from: 's2', to: 's3' });

    const del = await a.op({ kind: 'shape.delete', shapeId: 's1' });
    expect(del.acked).toBe(true);
    await a.waitSeq(del.seq!);
    await b.waitSeq(del.seq!);

    // c1、c2 挂在 s1 上被级联删除；c3 与 s1 无关，保留
    for (const client of [a, b]) {
      expect(client.shapes.has('s1')).toBe(false);
      expect(client.connectors.has('c1')).toBe(false);
      expect(client.connectors.has('c2')).toBe(false);
      expect(client.connectors.has('c3')).toBe(true);
    }
    // 重连快照中同样没有悬空连线
    const c2 = await join('c');
    expect([...c2.connectors.keys()]).toEqual(['c3']);
  });
});

describe('非法操作拒绝', () => {
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

  it('连线锚到不存在的图元被拒绝并说明原因', async () => {
    const a = await join('a');
    await a.op({ kind: 'shape.create', shape: makeShape('s1', 100, 100) });

    const r1 = await a.op({ kind: 'connector.create', id: 'c1', from: 's1', to: 'ghost' });
    expect(r1.acked).toBe(false);
    expect(r1.reason).toMatch(/不存在/);

    const r2 = await a.op({ kind: 'connector.create', id: 'c2', from: 'ghost', to: 's1' });
    expect(r2.acked).toBe(false);
    expect(r2.reason).toMatch(/不存在/);

    const r3 = await a.op({ kind: 'connector.create', id: 'c3', from: 's1', to: 's1' });
    expect(r3.acked).toBe(false);
    expect(r3.reason).toMatch(/同一个图元/);

    expect(a.connectors.size).toBe(0);
  });

  it('坐标/尺寸越界被拒绝，画布不进入不一致状态', async () => {
    const a = await join('a');
    const b = await join('b');
    const created = await a.op({ kind: 'shape.create', shape: makeShape('s1', 100, 100) });
    await a.waitSeq(created.seq!);
    await b.waitSeq(created.seq!);

    const r1 = await a.op({ kind: 'shape.set', shapeId: 's1', attrs: { x: 99999 } });
    expect(r1.acked).toBe(false);
    expect(r1.reason).toMatch(/越界/);

    const r2 = await a.op({ kind: 'shape.set', shapeId: 's1', attrs: { y: -50 } });
    expect(r2.acked).toBe(false);
    expect(r2.reason).toMatch(/越界/);

    const r3 = await a.op({ kind: 'shape.set', shapeId: 's1', attrs: { w: 1 } });
    expect(r3.acked).toBe(false);
    expect(r3.reason).toMatch(/越界/);

    const r4 = await a.op({ kind: 'shape.create', shape: makeShape('s2', -100, 0) });
    expect(r4.acked).toBe(false);
    expect(r4.reason).toMatch(/越界/);

    // 状态保持权威一致：s1 纹丝不动，s2 未创建
    expect(a.shapes.get('s1')!.x).toBe(100);
    expect(a.shapes.has('s2')).toBe(false);
    expect(statesEqualShapes(a, b)).toBe(true);
  });

  it('修改/删除不存在的图元、删除不存在的连线都被拒绝', async () => {
    const a = await join('a');
    const r1 = await a.op({ kind: 'shape.set', shapeId: 'ghost', attrs: { x: 10 } });
    expect(r1.acked).toBe(false);
    expect(r1.reason).toMatch(/不存在/);
    const r2 = await a.op({ kind: 'shape.delete', shapeId: 'ghost' });
    expect(r2.acked).toBe(false);
    expect(r2.reason).toMatch(/不存在/);
    const r3 = await a.op({ kind: 'connector.delete', connectorId: 'ghost' });
    expect(r3.acked).toBe(false);
    expect(r3.reason).toMatch(/不存在/);
  });
});

function statesEqualShapes(a: TestClient, b: TestClient): boolean {
  const norm = (c: TestClient) =>
    JSON.stringify({
      shapes: [...c.shapes.values()].sort((x, y) => x.id.localeCompare(y.id)),
      connectors: [...c.connectors.values()].sort((x, y) => x.id.localeCompare(y.id)),
    });
  return norm(a) === norm(b);
}
