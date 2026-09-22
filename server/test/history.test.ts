/**
 * 存档点时间线：打点、恢复、确定性重建、持久化、权限与并发定序。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { canonicalCheckpointString, type CheckpointState } from '../src/history.js';
import { MemoryStore } from '../src/persistence/store.js';
import type { CheckpointMeta } from '../src/types.js';
import { TestClient, makeShape, startServer, statesEqual } from './helpers.js';

type Srv = Awaited<ReturnType<typeof startServer>>;

/** 客户端视角的当前画布状态 -> 规范化串（与服务端重建结果比较） */
function clientStateString(c: TestClient): string {
  return canonicalCheckpointString({
    shapes: [...c.shapes.values()],
    connectors: [...c.connectors.values()],
    members: [...c.members.values()],
  });
}

function snapshotStateString(snap: { shapes: unknown[]; connectors: unknown[]; members: unknown[] }): string {
  return canonicalCheckpointString(snap as CheckpointState);
}

describe('存档点时间线', () => {
  let srv: Srv;
  let store: MemoryStore;
  const clients: TestClient[] = [];

  beforeEach(async () => {
    store = new MemoryStore();
    srv = await startServer(store);
  });
  afterEach(async () => {
    clients.forEach((c) => c.close());
    clients.length = 0;
    await srv.close();
  });

  const join = async (userId: string, name?: string) => {
    const c = await TestClient.connect(srv.port, { userId, name });
    clients.push(c);
    return c;
  };

  it('房主打点后存档点出现在列表，带名字/创建者/时刻/序列位置与独立稳定标识（名字可重复）', async () => {
    const owner = await join('owner', '房主');
    const viewer = await join('viewer', '围观');
    await owner.op({ kind: 'shape.create', shape: makeShape('s1', 100, 100) });

    const cp1 = await owner.createCheckpoint('评审前版本');
    expect(cp1.acked).toBe(true);
    const meta1 = cp1.checkpoint!;
    expect(meta1.name).toBe('评审前版本');
    expect(meta1.createdBy).toBe('owner');
    expect(meta1.createdByName).toBe('房主');
    expect(meta1.createdAt).toBeGreaterThan(0);
    expect(meta1.seq).toBe(1); // 对应操作序列里的位置

    // 名字允许重复，但标识各自独立
    const cp2 = await owner.createCheckpoint('评审前版本');
    expect(cp2.acked).toBe(true);
    expect(cp2.checkpoint!.id).not.toBe(meta1.id);
    expect(cp2.checkpoint!.name).toBe(meta1.name);

    // 所有在线成员都能看到列表（广播 + welcome 两条路径）
    await viewer.waitFor((m) => m.type === 'checkpoint.created' && m.checkpoint.id === cp2.checkpoint!.id);
    expect(viewer.checkpoints.map((c) => c.id)).toEqual(
      expect.arrayContaining([meta1.id, cp2.checkpoint!.id]),
    );

    // 重连后标识稳定，仍指向同一份历史
    const again = await TestClient.connect(srv.port, { userId: 'owner', lastSeq: owner.lastSeq });
    clients.push(again);
    const ids = again.welcome.checkpoints.map((c) => c.id);
    expect(ids).toEqual(expect.arrayContaining([meta1.id, cp2.checkpoint!.id]));
    const found = again.welcome.checkpoints.find((c) => c.id === meta1.id)!;
    expect(found.name).toBe('评审前版本');
    expect(found.seq).toBe(1);
  });

  it('非房主（可编辑/只读）打点被拒并给出可读原因，不产生任何存档点', async () => {
    const owner = await join('owner');
    const editor = await join('editor');
    const viewer = await join('viewer');
    owner.send({ type: 'role.set', userId: 'viewer', role: 'viewer' });
    await viewer.waitFor((m) => m.type === 'role.changed');

    const r1 = await editor.createCheckpoint('拆分方案A');
    expect(r1.acked).toBe(false);
    expect(r1.reason).toMatch(/房主/);

    const r2 = await viewer.createCheckpoint('拆分方案B');
    expect(r2.acked).toBe(false);
    expect(r2.reason).toMatch(/房主/);

    // 没有产生任何存档点，也没有广播
    const later = await owner.quiet(200);
    expect(later.filter((m) => m.type === 'checkpoint.created')).toHaveLength(0);
    expect(owner.checkpoints).toHaveLength(0);
  });

  it('恢复把整块画布切回存档点当时的图元/连线/成员，广播序列号自增且全员对齐', async () => {
    const a = await join('a', '房主');
    const b = await join('b', '成员B');

    await a.op({ kind: 'shape.create', shape: makeShape('s1', 100, 100) });
    await a.op({ kind: 'shape.create', shape: makeShape('s2', 400, 100) });
    const conn = await a.op({ kind: 'connector.create', id: 'c1', from: 's1', to: 's2' });
    const cp = await a.createCheckpoint('评审前版本');
    expect(cp.checkpoint!.seq).toBe(conn.seq);

    // 打点之后画布继续演进：移动、删除（级联连线）、新建、降级、新成员加入
    await a.op({ kind: 'shape.set', shapeId: 's1', attrs: { x: 900, y: 900 } });
    await a.op({ kind: 'shape.delete', shapeId: 's2' });
    const last = await a.op({ kind: 'shape.create', shape: makeShape('s3', 50, 50) });
    a.send({ type: 'role.set', userId: 'b', role: 'viewer' });
    await b.waitFor((m) => m.type === 'role.changed' && m.member.role === 'viewer');
    const c = await join('c', '后来者');
    expect(c.welcome.you.role).toBe('editor');

    // 房主发起恢复
    const restored = await a.restore(cp.checkpoint!.id);
    expect(restored.acked).toBe(true);
    // 恢复占一个新的序列位置：恰好是此前最大 seq + 1
    expect(restored.seq).toBe(last.seq! + 1);

    // 三个在线客户端都收到 restored 广播并对齐到存档点状态
    for (const client of [a, b, c]) {
      await client.waitFor((m) => m.type === 'restored' && m.seq === restored.seq);
      expect(client.shapes.get('s1')!.x).toBe(100);
      expect(client.shapes.get('s1')!.y).toBe(100);
      expect(client.shapes.has('s2')).toBe(true);
      expect(client.shapes.has('s3')).toBe(false);
      expect(client.connectors.has('c1')).toBe(true);
      // 成员角色一并回滚：b 恢复为可编辑；打点后才加入的 c 不在名单里
      expect(client.members.get('a')!.role).toBe('owner');
      expect(client.members.get('b')!.role).toBe('editor');
      expect(client.members.has('c')).toBe(false);
    }

    // 广播里的快照与服务端重建的存档点内容逐字节一致
    const engine = await srv.collab.getEngine('main');
    const restoredMsg = a.messages.find((m) => m.type === 'restored')!;
    expect(restoredMsg.type).toBe('restored');
    if (restoredMsg.type === 'restored') {
      expect(restoredMsg.checkpoint.id).toBe(cp.checkpoint!.id);
      expect(snapshotStateString(restoredMsg.snapshot)).toBe(
        canonicalCheckpointString(engine.rebuildCheckpoint(cp.checkpoint!.id)),
      );
    }

    // 恢复后序列继续自增：b 已恢复可编辑，新操作排在恢复之后
    const after = await b.op({ kind: 'shape.set', shapeId: 's1', attrs: { color: '#ff0000' } });
    expect(after.acked).toBe(true);
    expect(after.seq).toBe(restored.seq! + 1);

    // 被打点后才加入的 c 已不在成员中，写操作被拒
    const rejected = await c.op({ kind: 'shape.create', shape: makeShape('cx', 10, 10) });
    expect(rejected.acked).toBe(false);
    expect(rejected.reason).toMatch(/不是画布成员/);
  });

  it('恢复时进行中的拖动被作废：脏位置不进入权威状态、不落库、不进日志', async () => {
    const owner = await join('owner');
    const editor = await join('editor');
    const created = await editor.op({ kind: 'shape.create', shape: makeShape('s1', 10, 10) });
    await owner.waitSeq(created.seq!);
    const cp = await owner.createCheckpoint('干净基线');

    // editor 拖动中：只发临时预览（未提交），把图元拖到 (800,800)
    const dirty = { id: 's1', kind: 'rect' as const, x: 800, y: 800, w: 120, h: 80, z: 1, color: '#93c5fd', text: '' };
    editor.send({ type: 'preview', shapes: [dirty] });
    const preview = await owner.waitFor((m) => m.type === 'preview' && m.userId === 'editor');
    expect(preview.type === 'preview' && preview.shapes[0].x).toBe(800);

    // 拖动进行中房主发起恢复
    const restored = await owner.restore(cp.checkpoint!.id);
    expect(restored.acked).toBe(true);
    await editor.waitFor((m) => m.type === 'restored');

    // 权威状态是存档点位置，不是拖动中的脏位置
    expect(owner.shapes.get('s1')!.x).toBe(10);
    expect(editor.shapes.get('s1')!.x).toBe(10);

    // 没有任何一条 op 广播携带脏位置
    const dirtyOps = owner.messages.filter(
      (m) => m.type === 'op' && (m.forward.patchShapes ?? []).some((p) => p.attrs.x === 800 || p.attrs.y === 800),
    );
    expect(dirtyOps).toHaveLength(0);

    // 持久层与操作日志里也没有脏位置
    const persisted = await store.loadCanvas('main');
    expect(persisted!.shapes.find((s) => s.id === 's1')!.x).toBe(10);
    const dirtyLogs = persisted!.ops.filter(
      (e) =>
        (e.forward.patchShapes ?? []).some((p) => p.attrs.x === 800 || p.attrs.y === 800) ||
        (e.forward.upsertShapes ?? []).some((s) => s.x === 800 || s.y === 800),
    );
    expect(dirtyLogs).toHaveLength(0);

    // 恢复后服务端不再持有该用户的预览记录：preview.end 不再产生 preview.clear 广播
    editor.send({ type: 'preview.end' });
    const after = await owner.quiet(200);
    expect(after.filter((m) => m.type === 'preview.clear')).toHaveLength(0);
  });

  it('恢复后不产生悬空连线：被级联删除的连线随图元一起回来，多余的连线整体移除', async () => {
    const a = await join('a');
    await a.op({ kind: 'shape.create', shape: makeShape('s1', 100, 100) });
    await a.op({ kind: 'shape.create', shape: makeShape('s2', 400, 100) });
    await a.op({ kind: 'connector.create', id: 'c1', from: 's1', to: 's2' });
    const cp = await a.createCheckpoint('含连线版本');

    // 删除 s2（c1 级联删除），再新建两个图元和一条新连线
    await a.op({ kind: 'shape.delete', shapeId: 's2' });
    await a.op({ kind: 'shape.create', shape: makeShape('s3', 100, 400) });
    await a.op({ kind: 'shape.create', shape: makeShape('s4', 400, 400) });
    await a.op({ kind: 'connector.create', id: 'c2', from: 's3', to: 's4' });
    expect(a.connectors.has('c1')).toBe(false);
    expect(a.connectors.has('c2')).toBe(true);

    const restored = await a.restore(cp.checkpoint!.id);
    expect(restored.acked).toBe(true);

    // c1 连同 s2 一起恢复，c2 与 s3/s4 整体移除
    expect(a.shapes.has('s2')).toBe(true);
    expect(a.connectors.has('c1')).toBe(true);
    expect(a.connectors.has('c2')).toBe(false);
    expect(a.shapes.has('s3')).toBe(false);

    // 不变式：所有连线的两端都落在存在的图元上，没有悬空端点
    for (const conn of a.connectors.values()) {
      expect(a.shapes.has(conn.from)).toBe(true);
      expect(a.shapes.has(conn.to)).toBe(true);
    }
    // 持久层同样一致
    const persisted = await store.loadCanvas('main');
    for (const conn of persisted!.connectors) {
      expect(persisted!.shapes.some((s) => s.id === conn.from)).toBe(true);
      expect(persisted!.shapes.some((s) => s.id === conn.to)).toBe(true);
    }
  });

  it('倒回旧存档点后仍能继续编辑、打新点、再倒回任意点，中间历史不被物理删除', async () => {
    const a = await join('a');
    await a.op({ kind: 'shape.create', shape: makeShape('s1', 100, 100) });
    const p1 = (await a.createCheckpoint('布局v1')).checkpoint!;
    await a.op({ kind: 'shape.set', shapeId: 's1', attrs: { x: 300 } });
    const p2 = (await a.createCheckpoint('布局v2')).checkpoint!;
    await a.op({ kind: 'shape.set', shapeId: 's1', attrs: { x: 500 } });
    const p3 = (await a.createCheckpoint('布局v3')).checkpoint!;

    // 倒回最早的 v1
    const r1 = await a.restore(p1.id);
    expect(r1.acked).toBe(true);
    expect(a.shapes.get('s1')!.x).toBe(100);

    // 倒回后画布继续可编辑
    const color = await a.op({ kind: 'shape.set', shapeId: 's1', attrs: { color: '#123456' } });
    expect(color.acked).toBe(true);
    // 在倒回后的状态上打新点
    const p4 = (await a.createCheckpoint('v1基础上的改色')).checkpoint!;
    expect(p4.seq).toBe(color.seq);

    // 再倒回到更晚的 v3（恢复之后也可以向前跳）
    const r2 = await a.restore(p3.id);
    expect(r2.acked).toBe(true);
    expect(a.shapes.get('s1')!.x).toBe(500);
    expect(a.shapes.get('s1')!.color).not.toBe('#123456'); // v3 时还没有改色

    // 再倒回到 p4（恢复之后打的点）
    const r3 = await a.restore(p4.id);
    expect(r3.acked).toBe(true);
    expect(a.shapes.get('s1')!.x).toBe(100);
    expect(a.shapes.get('s1')!.color).toBe('#123456');

    // 时间线只向前延伸：三次恢复各占一个新 seq，单调递增
    expect(r2.seq!).toBeGreaterThan(r1.seq!);
    expect(r3.seq!).toBeGreaterThan(r2.seq!);

    // 所有存档点都还在，没有被物理删除
    const engine = await srv.collab.getEngine('main');
    expect(engine.listCheckpoints().map((c) => c.id)).toEqual(
      expect.arrayContaining([p1.id, p2.id, p3.id, p4.id]),
    );

    // 操作日志只增不删：1 创建 + 2 移动 + 1 改色 + 3 恢复 = 7 条，seq 连续
    const persisted = await store.loadCanvas('main');
    const seqs = persisted!.ops.map((o) => o.seq);
    expect(seqs).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(persisted!.ops.filter((o) => o.kind === 'restore')).toHaveLength(3);
    expect(persisted!.ops.filter((o) => o.kind === 'normal')).toHaveLength(4);
  });

  it('同一存档点无论何时、在哪个实例上重建，结果逐字节一致（不可变）', async () => {
    const a = await join('a', '房主');
    await join('b', '成员B');
    await a.op({ kind: 'shape.create', shape: makeShape('s1', 100, 100) });
    await a.op({ kind: 'shape.create', shape: makeShape('s2', 400, 100) });
    await a.op({ kind: 'connector.create', id: 'c1', from: 's1', to: 's2' });
    await a.op({ kind: 'shape.set', shapeId: 's1', attrs: { text: '逐字节一致' } });
    const cp = (await a.createCheckpoint('评审前版本')).checkpoint!;

    const engine1 = await srv.collab.getEngine('main');
    const rebuild1 = canonicalCheckpointString(engine1.rebuildCheckpoint(cp.id));

    // 打点之后画布大幅演进，甚至发生恢复：已落定的存档点不受影响
    await a.op({ kind: 'shape.set', shapeId: 's1', attrs: { x: 999, text: '改掉了' } });
    await a.op({ kind: 'shape.delete', shapeId: 's2' });
    await a.createCheckpoint('另一个点');
    await a.restore(cp.id);
    await a.op({ kind: 'shape.create', shape: makeShape('s9', 700, 700) });
    const rebuild2 = canonicalCheckpointString(engine1.rebuildCheckpoint(cp.id));
    expect(rebuild2).toBe(rebuild1);

    // 模拟另一个实例/重启：同一持久层重新加载引擎，重建结果仍然逐字节一致
    await srv.close();
    const srv2 = await startServer(store);
    const engine2 = await srv2.collab.getEngine('main');
    const rebuild3 = canonicalCheckpointString(engine2.rebuildCheckpoint(cp.id));
    expect(rebuild3).toBe(rebuild1);
    await srv2.close();
    srv = await startServer(store); // afterEach 统一关闭
  });

  it('重启后存档点与其历史内容仍在，仍可恢复到任意存档点', async () => {
    const a = await join('a');
    await join('b');
    await a.op({ kind: 'shape.create', shape: makeShape('s1', 100, 100) });
    const p1 = (await a.createCheckpoint('评审前版本')).checkpoint!;
    await a.op({ kind: 'shape.set', shapeId: 's1', attrs: { x: 500 } });
    const p2 = (await a.createCheckpoint('拆分方案A')).checkpoint!;
    await a.op({ kind: 'shape.delete', shapeId: 's1' });
    a.close();
    await srv.close();

    // 重启：同一持久层
    srv = await startServer(store);
    const a2 = await TestClient.connect(srv.port, { userId: 'a' });
    clients.push(a2);

    // 存档点列表随 welcome 恢复，标识稳定
    const metas = a2.welcome.checkpoints;
    expect(metas.map((m: CheckpointMeta) => m.id)).toEqual(expect.arrayContaining([p1.id, p2.id]));
    expect(metas.find((m: CheckpointMeta) => m.id === p1.id)!.name).toBe('评审前版本');

    // 历史内容仍可恢复：倒回 p1，s1 回到 (100,100)
    const r1 = await a2.restore(p1.id);
    expect(r1.acked).toBe(true);
    expect(a2.shapes.get('s1')!.x).toBe(100);
    // 再倒回 p2，s1 在 (500,100)
    const r2 = await a2.restore(p2.id);
    expect(r2.acked).toBe(true);
    expect(a2.shapes.get('s1')!.x).toBe(500);
    // 成员角色也随历史内容恢复（b 仍是成员）
    expect(a2.members.has('b')).toBe(true);
  });

  it('只读或非房主发起恢复一律被拒并说明原因；恢复不存在的存档点也被干净拒绝', async () => {
    const owner = await join('owner');
    const editor = await join('editor');
    const viewer = await join('viewer');
    owner.send({ type: 'role.set', userId: 'viewer', role: 'viewer' });
    await viewer.waitFor((m) => m.type === 'role.changed');

    await owner.op({ kind: 'shape.create', shape: makeShape('s1', 100, 100) });
    const cp = (await owner.createCheckpoint('基线')).checkpoint!;
    const seqBefore = (await owner.op({ kind: 'shape.set', shapeId: 's1', attrs: { x: 200 } })).seq!;

    // 非房主恢复：明确拒绝 + 可读原因
    const r1 = await editor.restore(cp.id);
    expect(r1.acked).toBe(false);
    expect(r1.reason).toMatch(/房主/);
    const r2 = await viewer.restore(cp.id);
    expect(r2.acked).toBe(false);
    expect(r2.reason).toMatch(/房主/);

    // 恢复不存在的存档点：明确拒绝
    const r3 = await owner.restore('cp-不存在');
    expect(r3.acked).toBe(false);
    expect(r3.reason).toMatch(/不存在/);

    // 没有广播任何 restored，画布状态与序列都没有被污染
    const quiet = await editor.quiet(200);
    expect(quiet.filter((m) => m.type === 'restored')).toHaveLength(0);
    expect(owner.shapes.get('s1')!.x).toBe(200);
    const next = await owner.op({ kind: 'shape.set', shapeId: 's1', attrs: { x: 300 } });
    expect(next.seq).toBe(seqBefore + 1); // 非法请求不占序列位置
  });

  it('恢复与并发写走同一条串行定序通道：不产生交错脏状态，全员收敛', async () => {
    const a = await join('a');
    const b = await join('b');
    await a.op({ kind: 'shape.create', shape: makeShape('s1', 100, 100) });
    await a.op({ kind: 'shape.create', shape: makeShape('s2', 400, 100) });
    await a.op({ kind: 'connector.create', id: 'c1', from: 's1', to: 's2' });
    const cp = (await a.createCheckpoint('并发基线')).checkpoint!;
    await b.waitFor((m) => m.type === 'checkpoint.created');

    // 房主恢复 与 另一成员的一串写操作 同时发出
    const setXs = [1000, 1001, 1002, 1003, 1004];
    const [restoreRes, ...results] = await Promise.all([
      a.restore(cp.id),
      ...setXs.map((x) => b.op({ kind: 'shape.set', shapeId: 's1', attrs: { x } })),
      b.op({ kind: 'shape.create', shape: makeShape('s3', 50, 50) }),
    ]);
    expect(restoreRes.acked).toBe(true);
    const restoreSeq = restoreRes.seq!;
    const setResults = results.slice(0, setXs.length);
    const createResult = results[setXs.length];
    for (const r of results) expect(r.acked).toBe(true);

    // 每个写操作都被干净地排在恢复之前或之后，绝不交错进恢复中间
    for (const r of results) expect(r.seq).not.toBe(restoreSeq);

    // 恢复广播那一刻的快照就是存档点本身：没有被并发写污染
    const restoredMsg = a.messages.find((m) => m.type === 'restored')!;
    expect(restoredMsg.type).toBe('restored');
    const engine = await srv.collab.getEngine('main');
    if (restoredMsg.type === 'restored') {
      expect(snapshotStateString(restoredMsg.snapshot)).toBe(
        canonicalCheckpointString(engine.rebuildCheckpoint(cp.id)),
      );
    }

    // 最终状态 = 存档点状态 + 恢复之后定序的写（按 seq 顺序）
    const postSets = setResults
      .map((r, i) => ({ seq: r.seq!, x: setXs[i] }))
      .filter((r) => r.seq > restoreSeq)
      .sort((p, q) => p.seq - q.seq);
    const expectedX = postSets.length > 0 ? postSets[postSets.length - 1].x : 100;
    const expectS3 = createResult.seq! > restoreSeq;

    const maxSeq = Math.max(restoreSeq, ...results.map((r) => r.seq!));
    await a.waitSeq(maxSeq);
    await b.waitSeq(maxSeq);
    expect(a.shapes.get('s1')!.x).toBe(expectedX);
    expect(b.shapes.get('s1')!.x).toBe(expectedX);
    expect(a.shapes.has('s3')).toBe(expectS3);
    expect(statesEqual(a, b)).toBe(true);

    // 无悬空连线；日志 seq 连续无缺口（定序没有被打乱）
    for (const conn of a.connectors.values()) {
      expect(a.shapes.has(conn.from)).toBe(true);
      expect(a.shapes.has(conn.to)).toBe(true);
    }
    const persisted = await store.loadCanvas('main');
    const seqs = persisted!.ops.map((o) => o.seq).sort((x, y) => x - y);
    expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, i) => i + 1));
    expect(persisted!.ops.filter((o) => o.kind === 'restore')).toHaveLength(1);
  });

  it('恢复是撤销/重做的屏障：撤销不会把画面拽回恢复前，恢复后的新操作可正常撤销', async () => {
    const a = await join('a');
    const b = await join('b');
    await a.op({ kind: 'shape.create', shape: makeShape('s1', 100, 100) });
    await b.op({ kind: 'shape.set', shapeId: 's1', attrs: { x: 300 } });
    const cp = (await a.createCheckpoint('屏障基线')).checkpoint!;
    await b.op({ kind: 'shape.set', shapeId: 's1', attrs: { x: 500 } });
    await a.op({ kind: 'shape.set', shapeId: 's1', attrs: { color: '#00ff00' } });

    const restored = await a.restore(cp.id);
    expect(restored.acked).toBe(true);
    await b.waitFor((m) => m.type === 'restored');
    expect(a.shapes.get('s1')!.x).toBe(300);

    // 恢复后，任何人撤销恢复前的操作都被拒绝：画面不会被拽回恢复前
    const undoB = await b.undo();
    expect(undoB.acked).toBe(false);
    expect(undoB.reason).toMatch(/没有可撤销/);
    const undoA = await a.undo();
    expect(undoA.acked).toBe(false);
    expect(undoA.reason).toMatch(/没有可撤销/);
    expect(a.shapes.get('s1')!.x).toBe(300);
    expect(a.shapes.get('s1')!.color).not.toBe('#00ff00'); // 恢复后的状态保持不动

    // 恢复这一步本身没有丢失：日志里留着 restore 条目，占一个 seq
    const persisted = await store.loadCanvas('main');
    const restoreEntries = persisted!.ops.filter((o) => o.kind === 'restore');
    expect(restoreEntries).toHaveLength(1);
    expect(restoreEntries[0].seq).toBe(restored.seq);
    // 恢复前的条目也原样保留（历史不被串改）
    expect(persisted!.ops.filter((o) => o.kind === 'normal')).toHaveLength(4);

    // 恢复之后的新操作可以正常撤销/重做（屏障只挡住恢复前的历史）
    const move = await b.op({ kind: 'shape.set', shapeId: 's1', attrs: { x: 700 } });
    expect(move.acked).toBe(true);
    const undo1 = await b.undo();
    expect(undo1.acked).toBe(true);
    await b.waitSeq(undo1.seq!);
    expect(b.shapes.get('s1')!.x).toBe(300); // 回到恢复后的基线，而不是恢复前
    const redo1 = await b.redo();
    expect(redo1.acked).toBe(true);
    await b.waitSeq(redo1.seq!);
    expect(b.shapes.get('s1')!.x).toBe(700);
  });

  it('恢复后断线重连：快照即恢复后状态，增量里包含恢复条目', async () => {
    const a = await join('a');
    const b = await join('b');
    await a.op({ kind: 'shape.create', shape: makeShape('s1', 100, 100) });
    const cp = (await a.createCheckpoint('基线')).checkpoint!;
    const moved = await a.op({ kind: 'shape.set', shapeId: 's1', attrs: { x: 600 } });
    await b.waitSeq(moved.seq!);
    const lastSeq = moved.seq!;
    b.close();
    await new Promise((r) => setTimeout(r, 100));

    // b 断线期间发生恢复
    const restored = await a.restore(cp.id);
    expect(restored.acked).toBe(true);

    // b 重连：快照直接是恢复后状态，增量里能看到 restore 条目
    const b2 = await TestClient.connect(srv.port, { userId: 'b', lastSeq });
    clients.push(b2);
    expect(b2.welcome.seq).toBe(restored.seq);
    expect(b2.shapes.get('s1')!.x).toBe(100);
    expect(b2.welcome.deltas.some((d) => d.seq === restored.seq)).toBe(true);
    expect(b2.welcome.checkpoints.map((c) => c.id)).toContain(cp.id);
    expect(statesEqual(a, b2)).toBe(true);
  });
});
