import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TestClient, makeShape, startServer, statesEqual } from './helpers.js';

describe('并发编辑收敛', () => {
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

  it('同一图元的不同属性并发修改：两个改动都保留（属性级合并）', async () => {
    const a = await join('a');
    const b = await join('b');
    const created = await a.op({ kind: 'shape.create', shape: makeShape('s1', 100, 100) });
    expect(created.acked).toBe(true);
    await b.waitFor((m) => m.type === 'op' && m.seq === created.seq);

    // a 挪位置，b 改颜色：同时发出，互不等待
    const movePromise = a.op({ kind: 'shape.set', shapeId: 's1', attrs: { x: 300, y: 260 } });
    const colorPromise = b.op({ kind: 'shape.set', shapeId: 's1', attrs: { color: '#ff0000' } });
    const [move, color] = await Promise.all([movePromise, colorPromise]);
    expect(move.acked).toBe(true);
    expect(color.acked).toBe(true);

    const maxSeq = Math.max(move.seq!, color.seq!);
    await a.waitFor((m) => m.type === 'op' && m.seq === maxSeq);
    await b.waitFor((m) => m.type === 'op' && m.seq === maxSeq);

    // 两个改动都保留，没有被整体覆盖
    for (const c of [a, b]) {
      const s = c.shapes.get('s1')!;
      expect(s.x).toBe(300);
      expect(s.y).toBe(260);
      expect(s.color).toBe('#ff0000');
    }
    expect(statesEqual(a, b)).toBe(true);
  });

  it('同一属性并发修改：按服务端接收顺序定序，所有客户端收敛到同一值', async () => {
    const a = await join('a');
    const b = await join('b');
    await a.op({ kind: 'shape.create', shape: makeShape('s1', 100, 100) });

    // 并发改同一属性 x：一个写 300，一个写 700
    const p1 = a.op({ kind: 'shape.set', shapeId: 's1', attrs: { x: 300 } });
    const p2 = b.op({ kind: 'shape.set', shapeId: 's1', attrs: { x: 700 } });
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.acked && r2.acked).toBe(true);

    // 服务端接收顺序（seq 大者）为最终值
    const winner = r1.seq! > r2.seq! ? 300 : 700;
    const maxSeq = Math.max(r1.seq!, r2.seq!);
    await a.waitFor((m) => m.type === 'op' && m.seq === maxSeq);
    await b.waitFor((m) => m.type === 'op' && m.seq === maxSeq);

    expect(a.shapes.get('s1')!.x).toBe(winner);
    expect(b.shapes.get('s1')!.x).toBe(winner);
    expect(statesEqual(a, b)).toBe(true);

    // 第三个客户端从快照看到的也是同一份
    const c = await join('c');
    expect(c.shapes.get('s1')!.x).toBe(winner);
  });

  it('高频并发混合修改：最终全部客户端状态逐位一致', async () => {
    const a = await join('a');
    const b = await join('b');
    await a.op({ kind: 'shape.create', shape: makeShape('s1', 100, 100) });
    await a.op({ kind: 'shape.create', shape: makeShape('s2', 500, 100) });

    const ops = [];
    for (let i = 0; i < 10; i++) {
      ops.push(a.op({ kind: 'shape.set', shapeId: 's1', attrs: { x: 100 + i * 10 } }));
      ops.push(b.op({ kind: 'shape.set', shapeId: 's1', attrs: { color: `#c0ff${String(i).padStart(2, '0')}` } }));
      ops.push(a.op({ kind: 'shape.set', shapeId: 's2', attrs: { y: 100 + i * 5 } }));
      ops.push(b.op({ kind: 'shape.set', shapeId: 's2', attrs: { text: `n${i}` } }));
    }
    const results = await Promise.all(ops);
    const maxSeq = Math.max(...results.map((r) => r.seq!));
    await a.waitFor((m) => m.type === 'op' && m.seq === maxSeq);
    await b.waitFor((m) => m.type === 'op' && m.seq === maxSeq);

    expect(statesEqual(a, b)).toBe(true);
    const c = await join('c');
    expect(statesEqual(a, c)).toBe(true);
  });
});
