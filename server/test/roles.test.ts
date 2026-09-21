import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TestClient, makeShape, startServer } from './helpers.js';

describe('角色与权限', () => {
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

  it('降级为只读：进行中的拖动立即回滚，半截脏位置不会进入权威状态，后续写被拒', async () => {
    const owner = await join('owner');
    const editor = await join('editor');
    expect(owner.welcome.you.role).toBe('owner');
    expect(editor.welcome.you.role).toBe('editor');

    // editor 创建图元并提交，初始位置 (100,100)
    const created = await editor.op({ kind: 'shape.create', shape: makeShape('s1', 100, 100) });
    expect(created.acked).toBe(true);
    await owner.waitFor((m) => m.type === 'op' && m.seq === created.seq);
    expect(owner.shapes.get('s1')?.x).toBe(100);

    // editor 开始拖动：只发临时预览（未提交），把图元拖到 (500,500)
    const dirty = { id: 's1', kind: 'rect' as const, x: 500, y: 500, w: 120, h: 80, z: 1, color: '#93c5fd', text: '' };
    editor.send({ type: 'preview', shapes: [dirty] });
    const preview = await owner.waitFor((m) => m.type === 'preview' && m.userId === 'editor');
    expect(preview.type === 'preview' && preview.shapes[0].x).toBe(500);

    // 房主在拖动进行中将其降级为只读
    owner.send({ type: 'role.set', userId: 'editor', role: 'viewer' });
    const roleChanged = await editor.waitFor((m) => m.type === 'role.changed');
    expect(roleChanged.type === 'role.changed' && roleChanged.member.role).toBe('viewer');

    // 房主收到 preview.clear，携带权威状态（100,100）：进行中的拖动回滚
    const cleared = await owner.waitFor((m) => m.type === 'preview.clear' && m.userId === 'editor');
    expect(cleared.type === 'preview.clear' && cleared.shapes[0].x).toBe(100);
    expect(cleared.type === 'preview.clear' && cleared.shapes[0].y).toBe(100);

    // 降级后才到达的提交（松手时刻的 commit）必须被拒绝，且回包带权威状态
    const commit = await editor.op({ kind: 'shape.set', shapeId: 's1', attrs: { x: 500, y: 500 } });
    expect(commit.acked).toBe(false);
    expect(commit.reason).toMatch(/只读/);
    const reject = commit.msg;
    expect(reject.type === 'op.reject' && reject.shapes?.[0]?.x).toBe(100);

    // 降级后的预览也不再被转发
    editor.send({ type: 'preview', shapes: [dirty] });
    const later = await owner.quiet(300);
    expect(later.filter((m) => m.type === 'preview')).toHaveLength(0);

    // 权威状态从未出现脏位置：没有任何一条 op 广播携带 x=500
    const dirtyOps = owner.messages.filter(
      (m) =>
        m.type === 'op' &&
        (m.forward.patchShapes ?? []).some((p) => p.id === 's1' && (p.attrs.x === 500 || p.attrs.y === 500)),
    );
    expect(dirtyOps).toHaveLength(0);
    expect(owner.shapes.get('s1')?.x).toBe(100);
    expect(owner.shapes.get('s1')?.y).toBe(100);
  });

  it('只读成员的任何写操作（创建/修改/删除/连线/撤销）都被拒绝并给出可读原因', async () => {
    const owner = await join('owner');
    const viewer = await join('viewer');
    owner.send({ type: 'role.set', userId: 'viewer', role: 'viewer' });
    await viewer.waitFor((m) => m.type === 'role.changed');

    const create = await viewer.op({ kind: 'shape.create', shape: makeShape('v1', 10, 10) });
    expect(create.acked).toBe(false);
    expect(create.reason).toMatch(/只读/);

    const set = await viewer.op({ kind: 'shape.set', shapeId: 'whatever', attrs: { x: 1 } });
    expect(set.acked).toBe(false);
    expect(set.reason).toMatch(/只读/);

    const del = await viewer.op({ kind: 'shape.delete', shapeId: 'whatever' });
    expect(del.acked).toBe(false);
    expect(del.reason).toMatch(/只读/);

    const conn = await viewer.op({ kind: 'connector.create', id: 'c1', from: 'a', to: 'b' });
    expect(conn.acked).toBe(false);
    expect(conn.reason).toMatch(/只读/);

    const undo = await viewer.undo();
    expect(undo.acked).toBe(false);
    expect(undo.reason).toMatch(/只读/);

    // 画布状态没有被污染
    expect(owner.shapes.size).toBe(0);
  });

  it('只读成员可以被房主恢复为可编辑，之后写操作正常', async () => {
    const owner = await join('owner');
    const member = await join('member');
    owner.send({ type: 'role.set', userId: 'member', role: 'viewer' });
    await member.waitFor((m) => m.type === 'role.changed' && m.member.role === 'viewer');
    expect((await member.op({ kind: 'shape.create', shape: makeShape('m1', 10, 10) })).acked).toBe(false);

    owner.send({ type: 'role.set', userId: 'member', role: 'editor' });
    await member.waitFor((m) => m.type === 'role.changed' && m.member.role === 'editor');
    expect((await member.op({ kind: 'shape.create', shape: makeShape('m1', 10, 10) })).acked).toBe(true);
  });

  it('非房主无权调整角色', async () => {
    await join('owner');
    const notOwner = await join('someone');
    notOwner.send({ type: 'role.set', userId: 'owner', role: 'viewer' });
    const err = await notOwner.waitFor((m) => m.type === 'error');
    expect(err.type === 'error' && err.reason).toMatch(/房主/);
  });
});
