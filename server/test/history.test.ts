import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TestClient, makeShape, startServer, statesEqual } from './helpers.js';
import type { Store } from '../src/persistence/store.js';
import { canonicalJson } from '../src/history.js';
import type { ServerMessage } from '../src/types.js';

describe('时间线：存档点与整画布恢复', () => {
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

  const join = async (userId: string, role?: 'editor' | 'viewer') => {
    const c = await TestClient.connect(srv.port, { userId });
    clients.push(c);
    if (role) {
      clients[0].send({ type: 'role.set', userId, role });
      await c.waitFor((m) => m.type === 'role.changed');
    }
    return c;
  };

  it('房主打点后存档点出现在所有人列表，带名字/创建者/时刻/序列位置与独立稳定标识；重名互不影响', async () => {
    const owner = await join('owner');
    const editor = await join('editor');

    const r = await owner.op({ kind: 'shape.create', shape: makeShape('s1', 100, 100) });
    await editor.waitSeq(r.seq!);

    const cp1 = await owner.checkpoint('评审前版本');
    expect(cp1.acked).toBe(true);
    expect(cp1.checkpoint).toBeTruthy();
    const info1 = cp1.checkpoint!;
    expect(info1.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(info1.name).toBe('评审前版本');
    expect(info1.createdBy).toBe('owner');
    expect(info1.creatorName).toBe('owner');
    expect(info1.seq).toBe(r.seq); // 打点不占 seq，指向打点时的序列位置
    expect(typeof info1.at).toBe('number');
    expect(info1.at).toBeGreaterThan(0);
    expect(info1.epoch).toBe(0);

    // 第二个成员也能在列表看到
    const listed = await editor.waitFor((m) => m.type === 'checkpoint.created');
    expect(listed.type === 'checkpoint.created' && listed.checkpoint.id).toBe(info1.id);
    expect(editor.checkpoints.map((c) => c.id)).toContain(info1.id);

    // 同名存档点：独立标识，各自指向同一份内容但不混淆
    await owner.op({ kind: 'shape.set', shapeId: 's1', attrs: { x: 300 } });
    const cp2 = await owner.checkpoint('评审前版本');
    expect(cp2.acked).toBe(true);
    expect(cp2.checkpoint!.id).not.toBe(info1.id);
    expect(cp2.checkpoint!.name).toBe(info1.name);
    expect(cp2.checkpoint!.seq).toBeGreaterThan(info1.seq);

    // 新加入成员的 welcome 快照带完整列表
    const late = await TestClient.connect(srv.port, { userId: 'late' });
    clients.push(late);
    expect(late.welcome.snapshot.checkpoints.map((c) => c.id).sort()).toEqual([info1.id, cp2.checkpoint!.id].sort());
  });

  it('非房主（可编辑/只读）打点被明确拒绝并给出可读原因，存档点不产生', async () => {
    const owner = await join('owner');
    const editor = await join('editor');
    const viewer = await join('viewer2', 'viewer');

    const byEditor = await editor.checkpoint('editor 想打点');
    expect(byEditor.acked).toBe(false);
    expect(byEditor.reason).toMatch(/房主/);

    const byViewer = await viewer.checkpoint('viewer 想打点');
    expect(byViewer.acked).toBe(false);
    expect(byViewer.reason).toMatch(/房主/);

    // 没有任何 checkpoint.created 广播，列表为空
    const leaked = owner.messages.filter((m) => m.type === 'checkpoint.created');
    expect(leaked).toHaveLength(0);
    expect(owner.welcome.snapshot.checkpoints).toHaveLength(0);
  });

  it('恢复把整块画布切回存档点当时的图元/连线/成员角色，广播带自增 seq 与新纪元，所有人立即对齐', async () => {
    const owner = await join('owner');
    const editor = await join('editor');

    // 存档点时刻：s1/s2 + 连线，editor 可编辑
    await owner.op({ kind: 'shape.create', shape: makeShape('s1', 100, 100) });
    await owner.op({ kind: 'shape.create', shape: makeShape('s2', 400, 100) });
    const conn = await owner.op({ kind: 'connector.create', id: 'c1', from: 's1', to: 's2' });
    await editor.waitSeq(conn.seq!);
    const cp = (await owner.checkpoint('拆分方案A')).checkpoint!;

    // 之后：新建 s3、删除 c1、移动 s1、把 editor 降级
    await owner.op({ kind: 'shape.create', shape: makeShape('s3', 200, 400) });
    await owner.op({ kind: 'connector.delete', connectorId: 'c1' });
    await owner.op({ kind: 'shape.set', shapeId: 's1', attrs: { x: 900, y: 900 } });
    owner.send({ type: 'role.set', userId: 'editor', role: 'viewer' });
    await editor.waitFor((m) => m.type === 'role.changed');
    expect(editor.shapes.has('s3')).toBe(true);
    expect(editor.connectors.has('c1')).toBe(false);

    const seqBefore = cp.seq;
    const restored = await owner.restore(cp.id);
    expect(restored.acked).toBe(true);
    expect(restored.seq).toBeGreaterThan(seqBefore);

    // 房主与被恢复的 editor 都收到 restore：新 seq、新纪元、一次性完整快照
    const rmOwner = await owner.waitRestore();
    const rmEditor = await editor.waitRestore();
    for (const rm of [rmOwner, rmEditor]) {
      expect(rm.seq).toBe(restored.seq);
      expect(rm.epoch).toBe(1);
      expect(rm.checkpointId).toBe(cp.id);
      expect(rm.snapshot.seq).toBe(restored.seq);
      expect(rm.snapshot.epoch).toBe(1);
    }

    // 图元：s3 消失，s1 回到原位；连线 c1 回来；成员角色恢复为 editor
    for (const c of [owner, editor]) {
      expect(c.shapes.has('s3')).toBe(false);
      expect(c.shapes.get('s1')!.x).toBe(100);
      expect(c.shapes.get('s1')!.y).toBe(100);
      expect(c.shapes.has('s2')).toBe(true);
      expect(c.connectors.has('c1')).toBe(true);
      expect(c.connectors.get('c1')!.from).toBe('s1');
      expect(c.connectors.get('c1')!.to).toBe('s2');
      expect(c.members.get('editor')!.role).toBe('editor');
      expect(c.epoch).toBe(1);
    }

    // 之后 editor 的写权限随角色恢复而恢复（恢复把角色也带回来了）
    const edit = await editor.op({ kind: 'shape.set', shapeId: 's1', attrs: { color: '#123456' } });
    expect(edit.acked).toBe(true);

    // 没有悬空连线
    for (const c of owner.connectors.values()) {
      expect(owner.shapes.has(c.from)).toBe(true);
      expect(owner.shapes.has(c.to)).toBe(true);
    }
  });

  it('删除图元（连带级联删除连线）后恢复：图元与连线一起回到存档点状态，无悬空端点', async () => {
    const owner = await join('owner');
    const editor = await join('editor');
    await owner.op({ kind: 'shape.create', shape: makeShape('s1', 100, 100) });
    await owner.op({ kind: 'shape.create', shape: makeShape('s2', 400, 100) });
    const conn = await owner.op({ kind: 'connector.create', id: 'c1', from: 's1', to: 's2' });
    await editor.waitSeq(conn.seq!);
    const cp = (await owner.checkpoint('连线都在')).checkpoint!;

    // 删掉 s1：c1 被级联删除
    const del = await owner.op({ kind: 'shape.delete', shapeId: 's1' });
    await editor.waitSeq(del.seq!);
    expect(owner.connectors.has('c1')).toBe(false);

    const restored = await owner.restore(cp.id);
    expect(restored.acked).toBe(true);
    await owner.waitRestore();
    await editor.waitRestore();

    for (const c of [owner, editor]) {
      expect(c.shapes.has('s1')).toBe(true);
      expect(c.shapes.has('s2')).toBe(true);
      const back = c.connectors.get('c1');
      expect(back).toBeTruthy();
      expect(back!.from).toBe('s1');
      expect(back!.to).toBe('s2');
      // 所有连线端点均有对应图元：无悬空
      for (const conn of c.connectors.values()) {
        expect(c.shapes.has(conn.from)).toBe(true);
        expect(c.shapes.has(conn.to)).toBe(true);
      }
    }
  });

  it('恢复不存在的存档点 / 非房主恢复 一律拒绝并说明原因，画布保持一致', async () => {
    const owner = await join('owner');
    const editor = await join('editor');
    const viewer = await join('viewer2', 'viewer');
    await owner.op({ kind: 'shape.create', shape: makeShape('s1', 100, 100) });

    const missing = await owner.restore('does-not-exist-id');
    expect(missing.acked).toBe(false);
    expect(missing.reason).toMatch(/不存在/);

    const byEditor = await editor.restore('whatever');
    expect(byEditor.acked).toBe(false);
    expect(byEditor.reason).toMatch(/房主/);

    const byViewer = await viewer.restore('whatever');
    expect(byViewer.acked).toBe(false);
    expect(byViewer.reason).toMatch(/房主/);

    // 没有任何 restore 广播，seq/纪元不变
    const restores = owner.messages.filter((m) => m.type === 'restore');
    expect(restores).toHaveLength(0);
    expect(owner.epoch).toBe(0);
    expect(owner.shapes.get('s1')!.x).toBe(100);
  });

  it('恢复时进行中的拖动被作废回弹，半截脏位置不落库、不盖在恢复画面上', async () => {
    const owner = await join('owner');
    const editor = await join('editor');

    const cr = await owner.op({ kind: 'shape.create', shape: makeShape('s1', 100, 100) });
    await editor.waitSeq(cr.seq!);
    const cp = (await owner.checkpoint('p0')).checkpoint!;
    // 存档点之后把 s1 挪到 200，使存档内容（100）与当前（200）不同
    const mv = await owner.op({ kind: 'shape.set', shapeId: 's1', attrs: { x: 200 } });
    await editor.waitSeq(mv.seq!);

    // editor 在 (200) 的基线上开始拖到 (700,700)，只发预览不提交
    const dirty = { id: 's1', kind: 'rect' as const, x: 700, y: 700, w: 120, h: 80, z: 1, color: '#93c5fd', text: '' };
    editor.send({ type: 'preview', shapes: [dirty] });
    await owner.waitFor((m) => m.type === 'preview' && m.userId === 'editor');

    // 房主发起恢复（恢复到 x=100 的存档点）
    const restored = await owner.restore(cp.id);
    expect(restored.acked).toBe(true);

    // editor：先收到自己预览被清除的回弹（权威态=恢复后的 100），再收到 restore
    const clear = (await editor.waitFor(
      (m) => m.type === 'preview.clear' && m.userId === 'editor',
    )) as Extract<ServerMessage, { type: 'preview.clear' }>;
    expect(clear.shapes[0].x).toBe(100);
    await editor.waitRestore();
    expect(editor.shapes.get('s1')!.x).toBe(100);

    // owner 也收到对 editor 的 preview.clear
    const ownerClear = await owner.waitFor(
      (m) => m.type === 'preview.clear' && m.userId === 'editor',
    );
    expect(ownerClear.type === 'preview.clear' && ownerClear.shapes[0].x).toBe(100);

    // 权威日志里从来没有 700 这个脏位置
    const dirtyOps = owner.messages.filter(
      (m) => m.type === 'op' && (m.forward.patchShapes ?? []).some((p) => p.id === 's1' && (p.attrs.x === 700 || p.attrs.y === 700)),
    );
    expect(dirtyOps).toHaveLength(0);
  });

  it('倒回旧存档点后仍可继续编辑、打新点、再倒回任意点；中间历史不被物理删除', async () => {
    const owner = await join('owner');
    const editor = await join('editor');

    // CP-A：s1@100
    await owner.op({ kind: 'shape.create', shape: makeShape('s1', 100, 100) });
    const cpA = (await owner.checkpoint('A')).checkpoint!;
    // 推进到 s1@500 + s2
    await owner.op({ kind: 'shape.set', shapeId: 's1', attrs: { x: 500 } });
    await owner.op({ kind: 'shape.create', shape: makeShape('s2', 300, 300) });
    const cpB = (await owner.checkpoint('B')).checkpoint!;

    // 倒回 A
    const r1 = await owner.restore(cpA.id);
    await editor.waitRestore();
    expect(r1.acked).toBe(true);
    expect(owner.shapes.get('s1')!.x).toBe(100);
    expect(owner.shapes.has('s2')).toBe(false);

    // 恢复之后继续编辑 + 打新点
    const editAfter = await editor.op({ kind: 'shape.set', shapeId: 's1', attrs: { color: '#000000' } });
    expect(editAfter.acked).toBe(true);
    const cpC = (await owner.checkpoint('C（恢复后）')).checkpoint!;
    expect(cpC.epoch).toBe(1);
    expect(cpC.seq).toBeGreaterThan(cpB.seq);

    // 再倒回更晚的 B（时间线只向前延伸，B 依然可用）
    const r2 = await owner.restore(cpB.id);
    await editor.waitFor((m) => m.type === 'restore' && m.seq === r2.seq);
    expect(owner.epoch).toBe(2);
    expect(owner.shapes.get('s1')!.x).toBe(500);
    expect(owner.shapes.has('s2')).toBe(true);

    // 再倒回 A：任意点都能回
    await owner.restore(cpA.id);
    await editor.waitFor((m) => m.type === 'restore');
    expect(owner.shapes.get('s1')!.x).toBe(100);
    expect(owner.shapes.has('s2')).toBe(false);

    // 三个存档点全都还在（中间历史未被物理删除）
    const ids = owner.checkpoints.map((c) => c.id).sort();
    expect(ids).toEqual([cpA.id, cpB.id, cpC.id].sort());

    // 服务端操作日志仍包含恢复前后的全部条目（经 HTTP 快照侧面验证 seq 单调推进）
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/canvases/main/snapshot`);
    const snap = await res.json();
    expect(snap.seq).toBeGreaterThanOrEqual(r2.seq! + 1);
    expect(snap.checkpoints).toHaveLength(3);
  });

  it('恢复与按人撤销/重做语义自洽：恢复后没人能一撤销跨过恢复点，也不丢/串他人改动', async () => {
    const owner = await join('owner');
    const a = await join('a');
    const b = await join('b');

    await a.op({ kind: 'shape.create', shape: makeShape('sa', 100, 100) });
    await b.op({ kind: 'shape.create', shape: makeShape('sb', 200, 200) });
    const cp = (await owner.checkpoint('p')).checkpoint!;

    // a、b 在存档点之后各自改东西
    await a.op({ kind: 'shape.set', shapeId: 'sa', attrs: { x: 600 } });
    await b.op({ kind: 'shape.set', shapeId: 'sb', attrs: { color: '#ff0000' } });

    // 房主恢复
    await owner.restore(cp.id);
    await a.waitRestore();
    await b.waitRestore();
    expect(a.shapes.get('sa')!.x).toBe(100);
    expect(b.shapes.get('sb')!.color).not.toBe('#ff0000');

    // a 撤销：没有当前纪元内的 normal 操作（a 的改动属于纪元 0），不能把画面拽回恢复前
    const undoA = await a.undo();
    expect(undoA.acked).toBe(false);
    expect(undoA.reason).toMatch(/没有可撤销/);
    const undoB = await b.undo();
    expect(undoB.acked).toBe(false);

    // 恢复后大家在新纪元里的新操作，撤销行为恢复正常且只影响本人
    const move = await a.op({ kind: 'shape.set', shapeId: 'sa', attrs: { x: 350 } });
    await b.waitSeq(move.seq!);
    const colorB = await b.op({ kind: 'shape.set', shapeId: 'sb', attrs: { color: '#00aa00' } });
    await a.waitSeq(colorB.seq!);
    const undoA2 = await a.undo();
    expect(undoA2.acked).toBe(true);
    await a.waitSeq(undoA2.seq!);
    expect(a.shapes.get('sa')!.x).toBe(100); // a 只回退自己的移动
    expect(a.shapes.get('sb')!.color).toBe('#00aa00'); // b 的改动保留
  });

  it('恢复与并发写共用同一串行通道：恢复不与并发写交错，最终无脏状态', async () => {
    const owner = await join('owner');
    const editor = await join('editor');
    await owner.op({ kind: 'shape.create', shape: makeShape('s1', 100, 100) });
    const cp = (await owner.checkpoint('p')).checkpoint!;
    await owner.op({ kind: 'shape.set', shapeId: 's1', attrs: { x: 500 } });

    // 恢复与一批并发写同时打到服务端：全部经同一队列串行
    const colors = ['#100001', '#100002', '#100003', '#100004', '#100005', '#100006', '#100007', '#100008'];
    const concurrent: Promise<unknown>[] = colors.map((color) =>
      editor.op({ kind: 'shape.set', shapeId: 's1', attrs: { color } }),
    );
    const restorePromise = owner.restore(cp.id);
    const results = (await Promise.all([...concurrent, restorePromise])) as { acked: boolean; seq?: number }[];
    const restoreResult = results[results.length - 1];
    expect(restoreResult.acked).toBe(true);

    await editor.waitFor((m) => m.type === 'restore');
    const restoreSeq = restoreResult.seq!;

    // seq 严格单调：每个 ack 的 seq 互不相同且连续区间内
    const seqs = results.filter((r) => r.acked).map((r) => r.seq!);
    expect(new Set(seqs).size).toBe(seqs.length);

    // 恢复之后：所有客户端状态 == 存档点（x=100），恢复前/并发写不会盖在恢复画面上
    const restoreMsg = owner.messages.filter((m) => m.type === 'restore').at(-1) as
      | Extract<ServerMessage, { type: 'restore' }>
      | undefined;
    expect(restoreMsg).toBeTruthy();
    // 恢复 seq 之后不应再有针对旧纪元的写广播造成分歧
    const laterOpMoved = owner.messages
      .filter((m): m is Extract<ServerMessage, { type: 'op' }> => m.type === 'op' && m.seq > restoreSeq)
      .filter((m) => (m.forward.patchShapes ?? []).some((p) => p.id === 's1' && p.attrs.x !== undefined));
    expect(laterOpMoved).toHaveLength(0);
    expect(restoreMsg!.snapshot.shapes.find((s) => s.id === 's1')!.x).toBe(100);
    expect(owner.shapes.get('s1')!.x).toBe(100);
    expect(statesEqual(owner, editor)).toBe(true);
  });
});

describe('存档内容的确定性重建与持久化', () => {
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
  it('同一存档点在任意实例上多次重建结果逐字节一致', async () => {
    const owner = await TestClient.connect(srv.port, { userId: 'owner' });
    clients.push(owner);
    await owner.op({ kind: 'shape.create', shape: makeShape('s2', 400, 100) });
    await owner.op({ kind: 'shape.create', shape: makeShape('s1', 100, 100) });
    await owner.op({ kind: 'connector.create', id: 'c9', from: 's1', to: 's2' });
    const cp = (await owner.checkpoint('确定性')).checkpoint!;

    // 直接从引擎（内存实例）与经过 HTTP 快照两条路径取同一点的内容体
    const engine = await srv.collab.getEngine('main');
    const stored = engine.checkpoints.find((c) => c.id === cp.id)!;
    const digest1 = canonicalJson(stored.state);

    // 模拟"另一个实例"：丢弃引擎缓存，强制重新从持久层 load
    (srv.collab as unknown as { engines: Map<string, unknown> }).engines.delete('main');
    const engine2 = await srv.collab.getEngine('main');
    const stored2 = engine2.checkpoints.find((c) => c.id === cp.id)!;
    const digest2 = canonicalJson(stored2.state);

    expect(digest2).toBe(digest1);
    // 再重建一次仍然一致
    (srv.collab as unknown as { engines: Map<string, unknown> }).engines.delete('main');
    const engine3 = await srv.collab.getEngine('main');
    const stored3 = engine3.checkpoints.find((c) => c.id === cp.id)!;
    expect(canonicalJson(stored3.state)).toBe(digest1);

    // 数组顺序稳定（不依赖插入顺序）
    expect(stored.state.shapes.map((s) => s.id)).toEqual(['s1', 's2']);
    expect(stored.state.connectors[0].id).toBe('c9');
  });

  it('重启后所有存档点及其指向的历史内容仍在，且可恢复；当前画布与定序也续接', async () => {
    const store: Store = srv.store;
    const owner = await TestClient.connect(srv.port, { userId: 'owner' });
    clients.push(owner);
    await owner.op({ kind: 'shape.create', shape: makeShape('s1', 100, 100) });
    await owner.op({ kind: 'shape.create', shape: makeShape('s2', 400, 100) });
    await owner.op({ kind: 'connector.create', id: 'c1', from: 's1', to: 's2' });
    const cp = (await owner.checkpoint('重启前')).checkpoint!;
    await owner.op({ kind: 'shape.set', shapeId: 's1', attrs: { x: 800 } });
    const seqAfter = owner.lastSeq;
    owner.close();
    await srv.close();
    clients.length = 0;

    // 用同一持久层重启
    srv = await startServer(store);
    const owner2 = await TestClient.connect(srv.port, { userId: 'owner' });
    clients.push(owner2);

    // 存档点列表与内容都在
    expect(owner2.welcome.snapshot.checkpoints.map((c) => c.id)).toContain(cp.id);
    const restored = await owner2.restore(cp.id);
    expect(restored.acked).toBe(true);
    await owner2.waitRestore();
    expect(owner2.shapes.get('s1')!.x).toBe(100);
    expect(owner2.shapes.has('s2')).toBe(true);
    expect(owner2.connectors.has('c1')).toBe(true);
    // 重启后 seq 继续单调向前（恢复占新 seq）
    expect(restored.seq).toBeGreaterThan(seqAfter);
    expect(owner2.welcome.snapshot.seq).toBe(seqAfter);
  });
});
