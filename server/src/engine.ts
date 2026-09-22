/**
 * 定序合并引擎：
 * - 所有写操作经 enqueue 串行化，服务端接收顺序即全局定序（seq 单调递增）。
 * - 操作为属性级绝对值语义：不同属性的并发修改天然合并互不覆盖；
 *   同一属性的并发修改按 seq 后到的覆盖先到的，且所有客户端按同一
 *   seq 顺序应用广播，最终收敛到同一份画布。
 * - 每次提交生成 forward/inverse 效果对并写入操作日志；
 *   撤销 = 应用本人最近一条 normal 日志的 inverse（只回退该步涉及的属性，
 *   他人对同一图元其它属性的改动不受影响）；重做同理。
 * - 图元几何变化后，受影响连线经路由模块重算，路径随操作一并广播。
 */

import { OpError, assertCanEdit, assertCanManageHistory, assertCanManageRoles, isValidRole } from './permissions.js';
import { canonicalState, diffStates } from './history.js';
import { routeConnector } from './router.js';
import type { Store } from './persistence/store.js';
import {
  BOUNDS,
  type CanvasState,
  type Checkpoint,
  type CheckpointInfo,
  type Connector,
  type Effects,
  type LogEntry,
  type Member,
  type Op,
  type Role,
  type Shape,
  type ShapeAttrs,
} from './types.js';

const MEMBER_COLORS = ['#ef4444', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316'];

const SHAPE_DEFAULT_COLORS: Record<Shape['kind'], string> = {
  rect: '#93c5fd',
  ellipse: '#86efac',
  note: '#fde047',
};

const GEOMETRY_KEYS = new Set(['x', 'y', 'w', 'h']);
const PATCHABLE_KEYS = new Set(['x', 'y', 'w', 'h', 'z', 'color', 'text']);

export class Engine {
  readonly state: CanvasState;
  readonly log: LogEntry[] = [];
  /** 存档点（只增不改不删），按创建顺序 */
  readonly checkpoints: Checkpoint[] = [];
  /** 当前时间线纪元：每恢复一次 +1，0 = 从未恢复过 */
  epoch = 0;
  private store: Store;
  /** 串行化队列：保证 定序 = 接收顺序 = 持久化顺序（打点/恢复/普通写共用一条） */
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(state: CanvasState, store: Store) {
    this.state = state;
    this.store = store;
  }

  static async load(store: Store, canvasId: string, canvasName: string): Promise<Engine> {
    await store.ensureCanvas(canvasId, canvasName);
    const persisted = await store.loadCanvas(canvasId);
    const state: CanvasState = {
      id: canvasId,
      seq: 0,
      shapes: new Map(),
      connectors: new Map(),
      members: new Map(),
    };
    const engine = new Engine(state, store);
    if (persisted) {
      for (const s of persisted.shapes) state.shapes.set(s.id, s);
      for (const c of persisted.connectors) state.connectors.set(c.id, c);
      for (const m of persisted.members) state.members.set(m.userId, m);
      for (const e of persisted.ops) {
        // 兼容旧数据：没有纪元字段的老日志一律视为纪元 0
        e.epoch ??= 0;
        engine.log.push(e);
      }
      // 兼容旧数据：没有纪元字段的老存档点一律视为纪元 0
      for (const cp of persisted.checkpoints ?? []) {
        cp.epoch ??= 0;
        engine.checkpoints.push(cp);
      }
      state.seq = persisted.ops.reduce((max, e) => Math.max(max, e.seq), 0);
      engine.epoch = persisted.ops.reduce((max, e) => Math.max(max, e.epoch ?? 0), 0);
    }
    return engine;
  }

  /** 所有变更经同一队列串行执行，实现服务端接收顺序定序 */
  enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn);
    this.queue = run.catch(() => {});
    return run;
  }

  /* ---------------- 成员与角色 ---------------- */

  async join(userId: string, name: string): Promise<{ member: Member; isNew: boolean }> {
    const existing = this.state.members.get(userId);
    if (existing) {
      if (name && name !== existing.name) {
        existing.name = name;
        await this.store.upsertMember(this.state.id, existing);
      }
      return { member: existing, isNew: false };
    }
    const member: Member = {
      userId,
      name: name || `用户-${userId.slice(0, 4)}`,
      role: this.state.members.size === 0 ? 'owner' : 'editor',
      color: MEMBER_COLORS[this.state.members.size % MEMBER_COLORS.length],
    };
    this.state.members.set(userId, member);
    await this.store.upsertMember(this.state.id, member);
    return { member, isNew: true };
  }

  getMember(userId: string): Member | undefined {
    return this.state.members.get(userId);
  }

  /** 房主在协作过程中随时切换成员角色（可编辑 <-> 只读） */
  async setRole(requesterId: string, targetId: string, role: Role): Promise<Member> {
    const requester = this.state.members.get(requesterId);
    assertCanManageRoles(requester, requesterId);
    if (!isValidRole(role)) throw new OpError(`非法角色: ${String(role)}`);
    if (role === 'owner') throw new OpError('不支持转让房主身份');
    if (requesterId === targetId) throw new OpError('房主不能修改自己的角色');
    const target = this.state.members.get(targetId);
    if (!target) throw new OpError(`用户 ${targetId} 不是画布成员`);
    target.role = role;
    await this.store.upsertMember(this.state.id, target);
    return target;
  }

  /* ---------------- 操作入口 ---------------- */

  async applyOp(userId: string, op: Op): Promise<LogEntry> {
    const member = this.state.members.get(userId);
    assertCanEdit(member, userId);
    const forward = this.buildForward(op);
    return this.commit(userId, 'normal', forward, this.describe(op));
  }

  async undo(userId: string): Promise<LogEntry> {
    const member = this.state.members.get(userId);
    assertCanEdit(member, userId);
    // 只在当前纪元内回退：恢复（跨所有人的整画布跳变）之后，
    // 任何人都不可能用撤销跨过恢复点把画面拽回恢复前。
    const target = [...this.log]
      .reverse()
      .find((e) => e.userId === userId && e.kind === 'normal' && !e.undone && e.epoch === this.epoch);
    if (!target) throw new OpError('没有可撤销的操作');
    const entry = await this.commit(userId, 'undo', target.inverse, `撤销：${target.label}`, target.seq);
    await this.markFlags(target.seq, { undone: true, undoneBy: entry.seq });
    return entry;
  }

  async redo(userId: string): Promise<LogEntry> {
    const member = this.state.members.get(userId);
    assertCanEdit(member, userId);
    const target = [...this.log]
      .filter((e) => e.userId === userId && e.kind === 'normal' && e.undone && e.redoable && e.epoch === this.epoch)
      .sort((a, b) => (b.undoneBy ?? 0) - (a.undoneBy ?? 0))[0];
    if (!target) throw new OpError('没有可重做的操作');
    const entry = await this.commit(userId, 'redo', target.forward, `重做：${target.label}`, target.seq);
    await this.markFlags(target.seq, { undone: false, undoneBy: null });
    return entry;
  }

  /* ---------------- 校验：拒绝越权/越界/悬空引用 ---------------- */

  private buildForward(op: Op): Effects {
    switch (op.kind) {
      case 'shape.create':
        return this.buildShapeCreate(op);
      case 'shape.set':
        return this.buildShapeSet(op);
      case 'shape.delete':
        return this.buildShapeDelete(op);
      case 'connector.create':
        return this.buildConnectorCreate(op);
      case 'connector.delete':
        return this.buildConnectorDelete(op);
    }
  }

  private checkBounds(attrs: ShapeAttrs, shapeId: string) {
    const inRange = (v: number, lo: number, hi: number) => Number.isFinite(v) && v >= lo && v <= hi;
    if (attrs.x !== undefined && !inRange(attrs.x, BOUNDS.minX, BOUNDS.maxX))
      throw new OpError(`坐标 x=${attrs.x} 越界（合法范围 [${BOUNDS.minX}, ${BOUNDS.maxX}]）`, { shapeIds: [shapeId] });
    if (attrs.y !== undefined && !inRange(attrs.y, BOUNDS.minY, BOUNDS.maxY))
      throw new OpError(`坐标 y=${attrs.y} 越界（合法范围 [${BOUNDS.minY}, ${BOUNDS.maxY}]）`, { shapeIds: [shapeId] });
    if (attrs.w !== undefined && !inRange(attrs.w, BOUNDS.minW, BOUNDS.maxW))
      throw new OpError(`宽度 w=${attrs.w} 越界（合法范围 [${BOUNDS.minW}, ${BOUNDS.maxW}]）`, { shapeIds: [shapeId] });
    if (attrs.h !== undefined && !inRange(attrs.h, BOUNDS.minH, BOUNDS.maxH))
      throw new OpError(`高度 h=${attrs.h} 越界（合法范围 [${BOUNDS.minH}, ${BOUNDS.maxH}]）`, { shapeIds: [shapeId] });
    if (attrs.z !== undefined && (!Number.isInteger(attrs.z) || attrs.z < 0 || attrs.z > BOUNDS.maxZ))
      throw new OpError(`层级 z=${attrs.z} 非法`, { shapeIds: [shapeId] });
    if (attrs.color !== undefined && (typeof attrs.color !== 'string' || attrs.color.length > 64))
      throw new OpError('颜色值非法', { shapeIds: [shapeId] });
    if (attrs.text !== undefined && (typeof attrs.text !== 'string' || attrs.text.length > BOUNDS.maxText))
      throw new OpError(`文本长度超过上限 ${BOUNDS.maxText}`, { shapeIds: [shapeId] });
  }

  private buildShapeCreate(op: Extract<Op, { kind: 'shape.create' }>): Effects {
    const s = op.shape;
    if (!s.id || typeof s.id !== 'string') throw new OpError('图元 id 非法');
    if (this.state.shapes.has(s.id)) throw new OpError(`图元 ${s.id} 已存在`, { shapeIds: [s.id] });
    if (!['rect', 'ellipse', 'note'].includes(s.kind)) throw new OpError(`未知图元类型: ${String(s.kind)}`);
    const attrs: ShapeAttrs = { x: s.x, y: s.y, w: s.w, h: s.h };
    if (s.z !== undefined) attrs.z = s.z;
    if (s.color !== undefined) attrs.color = s.color;
    if (s.text !== undefined) attrs.text = s.text;
    this.checkBounds(attrs, s.id);
    const maxZ = Math.max(0, ...[...this.state.shapes.values()].map((x) => x.z));
    const shape: Shape = {
      id: s.id,
      kind: s.kind,
      x: s.x,
      y: s.y,
      w: s.w,
      h: s.h,
      z: s.z ?? maxZ + 1,
      color: s.color ?? SHAPE_DEFAULT_COLORS[s.kind],
      text: s.text ?? (s.kind === 'note' ? '双击编辑便签' : ''),
    };
    return { upsertShapes: [shape] };
  }

  private buildShapeSet(op: Extract<Op, { kind: 'shape.set' }>): Effects {
    const shape = this.state.shapes.get(op.shapeId);
    if (!shape) throw new OpError(`图元 ${op.shapeId} 不存在`, { shapeIds: [op.shapeId] });
    const keys = Object.keys(op.attrs);
    if (keys.length === 0) throw new OpError('空的属性修改', { shapeIds: [op.shapeId] });
    for (const k of keys) {
      if (!PATCHABLE_KEYS.has(k)) throw new OpError(`属性 ${k} 不可修改`, { shapeIds: [op.shapeId] });
    }
    this.checkBounds(op.attrs, op.shapeId);
    return { patchShapes: [{ id: op.shapeId, attrs: { ...op.attrs } }] };
  }

  private buildShapeDelete(op: Extract<Op, { kind: 'shape.delete' }>): Effects {
    const shape = this.state.shapes.get(op.shapeId);
    if (!shape) throw new OpError(`图元 ${op.shapeId} 不存在`, { shapeIds: [op.shapeId] });
    // 级联：挂在该图元上的连线一并删除，不留悬空端点
    const attached = [...this.state.connectors.values()].filter(
      (c) => c.from === op.shapeId || c.to === op.shapeId,
    );
    return {
      deleteShapeIds: [op.shapeId],
      deleteConnectorIds: attached.map((c) => c.id),
    };
  }

  private buildConnectorCreate(op: Extract<Op, { kind: 'connector.create' }>): Effects {
    if (!op.id || typeof op.id !== 'string') throw new OpError('连线 id 非法');
    if (this.state.connectors.has(op.id)) throw new OpError(`连线 ${op.id} 已存在`, { connectorIds: [op.id] });
    if (op.from === op.to) throw new OpError('连线两端不能锚在同一个图元上');
    const from = this.state.shapes.get(op.from);
    const to = this.state.shapes.get(op.to);
    if (!from)
      throw new OpError(`连线起点锚定的图元 ${op.from} 不存在`, { shapeIds: [op.from], connectorIds: [op.id] });
    if (!to)
      throw new OpError(`连线终点锚定的图元 ${op.to} 不存在`, { shapeIds: [op.to], connectorIds: [op.id] });
    const route = routeConnector(from, to);
    const connector: Connector = { id: op.id, from: op.from, to: op.to, ...route };
    return { upsertConnectors: [connector] };
  }

  private buildConnectorDelete(op: Extract<Op, { kind: 'connector.delete' }>): Effects {
    if (!this.state.connectors.has(op.connectorId))
      throw new OpError(`连线 ${op.connectorId} 不存在`, { connectorIds: [op.connectorId] });
    return { deleteConnectorIds: [op.connectorId] };
  }

  /* ---------------- 提交：应用效果 + 计算逆操作 + 连线重算 + 日志 + 持久化 ---------------- */

  private async commit(
    userId: string,
    kind: LogEntry['kind'],
    template: Effects,
    label: string,
    targetSeq?: number,
    meta?: { checkpointId?: string; checkpointName?: string },
  ): Promise<LogEntry> {
    const forward: Effects = {};
    const inverse: Effects = {};
    const geometryTouched = new Set<string>();

    // upsertShapes：创建/恢复。逆操作为删除。
    for (const s of template.upsertShapes ?? []) {
      const prev = this.state.shapes.get(s.id);
      if (prev) {
        // 恢复场景下已存在（幂等重放）：逆操作为恢复旧值
        (inverse.upsertShapes ??= []).push(structuredClone(prev));
      } else {
        (inverse.deleteShapeIds ??= []).push(s.id);
      }
      this.state.shapes.set(s.id, structuredClone(s));
      (forward.upsertShapes ??= []).push(structuredClone(s));
      geometryTouched.add(s.id);
    }

    // patchShapes：属性级补丁。逆操作只记录被触及属性的旧值。
    for (const p of template.patchShapes ?? []) {
      const shape = this.state.shapes.get(p.id);
      if (!shape) throw new OpError(`图元 ${p.id} 已不存在，操作无法应用`, { shapeIds: [p.id] });
      const before: ShapeAttrs = {};
      for (const [k, v] of Object.entries(p.attrs)) {
        const key = k as keyof ShapeAttrs;
        (before as Record<string, unknown>)[key] = shape[key as keyof Shape];
        (shape as unknown as Record<string, unknown>)[key] = v;
        if (GEOMETRY_KEYS.has(key)) geometryTouched.add(p.id);
      }
      (forward.patchShapes ??= []).push({ id: p.id, attrs: { ...p.attrs } });
      (inverse.patchShapes ??= []).push({ id: p.id, attrs: before });
    }

    // deleteShapeIds：删除并级联连线。逆操作为完整恢复。
    for (const id of template.deleteShapeIds ?? []) {
      const shape = this.state.shapes.get(id);
      if (!shape) continue;
      (inverse.upsertShapes ??= []).push(structuredClone(shape));
      this.state.shapes.delete(id);
      (forward.deleteShapeIds ??= []).push(id);
      for (const c of [...this.state.connectors.values()]) {
        if (c.from === id || c.to === id) {
          (inverse.upsertConnectors ??= []).push(structuredClone(c));
          this.state.connectors.delete(c.id);
          (forward.deleteConnectorIds ??= []).push(c.id);
        }
      }
    }

    // upsertConnectors：创建/恢复连线（路径以当前图元重算为准）。
    for (const c of template.upsertConnectors ?? []) {
      const from = this.state.shapes.get(c.from);
      const to = this.state.shapes.get(c.to);
      if (!from || !to) continue; // 端点缺失则跳过，避免悬空
      const route = routeConnector(from, to);
      const conn: Connector = { ...c, ...route };
      const prev = this.state.connectors.get(c.id);
      if (prev) (inverse.upsertConnectors ??= []).push(structuredClone(prev));
      else (inverse.deleteConnectorIds ??= []).push(c.id);
      this.state.connectors.set(c.id, conn);
      (forward.upsertConnectors ??= []).push(structuredClone(conn));
    }

    // deleteConnectorIds：删除连线。逆操作为恢复。
    for (const id of template.deleteConnectorIds ?? []) {
      const conn = this.state.connectors.get(id);
      if (!conn) continue;
      (inverse.upsertConnectors ??= []).push(structuredClone(conn));
      this.state.connectors.delete(id);
      (forward.deleteConnectorIds ??= []).push(id);
    }

    // upsertMembers：成员整体切换（恢复时携带角色等）。逆操作为恢复旧成员。
    for (const m of template.upsertMembers ?? []) {
      const prev = this.state.members.get(m.userId);
      if (prev) (inverse.upsertMembers ??= []).push(structuredClone(prev));
      else (inverse.deleteMemberIds ??= []).push(m.userId);
      this.state.members.set(m.userId, structuredClone(m));
      (forward.upsertMembers ??= []).push(structuredClone(m));
    }
    for (const id of template.deleteMemberIds ?? []) {
      const prev = this.state.members.get(id);
      if (!prev) continue;
      (inverse.upsertMembers ??= []).push(structuredClone(prev));
      this.state.members.delete(id);
      (forward.deleteMemberIds ??= []).push(id);
    }

    // 几何变化 -> 受影响连线重算（端点重新贴合最近锚点，路径重算）。
    // restore 直接采用存档记录的连线，不做重算（存档内容即权威）。
    if (kind !== 'restore' && geometryTouched.size > 0) {
      for (const conn of this.state.connectors.values()) {
        if (!geometryTouched.has(conn.from) && !geometryTouched.has(conn.to)) continue;
        const from = this.state.shapes.get(conn.from);
        const to = this.state.shapes.get(conn.to);
        if (!from || !to) continue;
        const route = routeConnector(from, to);
        if (
          route.fromSide !== conn.fromSide ||
          route.toSide !== conn.toSide ||
          route.path.join(',') !== conn.path.join(',')
        ) {
          conn.fromSide = route.fromSide;
          conn.toSide = route.toSide;
          conn.path = route.path;
          (forward.upsertConnectors ??= []).push(structuredClone(conn));
        }
      }
    }

    const entry: LogEntry = {
      seq: this.state.seq + 1,
      userId,
      kind,
      forward,
      inverse,
      targetSeq,
      undone: false,
      redoable: true,
      epoch: this.epoch,
      at: Date.now(),
      label,
      checkpointId: meta?.checkpointId,
      checkpointName: meta?.checkpointName,
    };
    this.state.seq = entry.seq;
    this.log.push(entry);

    // 本人产生新的 normal 操作后，此前被撤销的条目不可再重做
    if (kind === 'normal') {
      for (const e of this.log) {
        if (e.userId === userId && e.kind === 'normal' && e.undone && e.redoable) {
          e.redoable = false;
          await this.store.updateOpFlags(this.state.id, e.seq, { redoable: false });
        }
      }
    }

    await this.persist(entry, kind === 'restore');
    return entry;
  }

  private async persist(entry: LogEntry, wholeStateInOp: boolean): Promise<void> {
    const canvasId = this.state.id;
    // restore 条目：实体切换已随 appendOp 在同一事务落库，不再逐条写
    if (wholeStateInOp) {
      await this.store.appendOp(canvasId, entry);
      return;
    }
    await this.store.appendOp(canvasId, entry);
    const forward = entry.forward;
    for (const s of forward.upsertShapes ?? []) await this.store.upsertShape(canvasId, s);
    for (const p of forward.patchShapes ?? []) {
      const s = this.state.shapes.get(p.id);
      if (s) await this.store.upsertShape(canvasId, s);
    }
    for (const id of forward.deleteShapeIds ?? []) await this.store.deleteShape(canvasId, id);
    for (const c of forward.upsertConnectors ?? []) await this.store.upsertConnector(canvasId, c);
    for (const id of forward.deleteConnectorIds ?? []) await this.store.deleteConnector(canvasId, id);
  }

  private async markFlags(seq: number, flags: { undone?: boolean; undoneBy?: number | null; redoable?: boolean }) {
    const entry = this.log.find((e) => e.seq === seq);
    if (!entry) return;
    if (flags.undone !== undefined) entry.undone = flags.undone;
    if (flags.undoneBy !== undefined) entry.undoneBy = flags.undoneBy === null ? undefined : flags.undoneBy;
    if (flags.redoable !== undefined) entry.redoable = flags.redoable;
    await this.store.updateOpFlags(this.state.id, seq, flags);
  }

  private describe(op: Op): string {
    switch (op.kind) {
      case 'shape.create':
        return `创建${op.shape.kind === 'note' ? '便签' : '图形'} ${op.shape.id.slice(0, 6)}`;
      case 'shape.set':
        return `修改图元 ${op.shapeId.slice(0, 6)} 的 ${Object.keys(op.attrs).join('/')}`;
      case 'shape.delete':
        return `删除图元 ${op.shapeId.slice(0, 6)}`;
      case 'connector.create':
        return `创建连线 ${op.id.slice(0, 6)}`;
      case 'connector.delete':
        return `删除连线 ${op.connectorId.slice(0, 6)}`;
    }
  }

  /* ---------------- 历史存档点 / 整画布恢复 ---------------- */

  listCheckpoints(): CheckpointInfo[] {
    return this.checkpoints.map((cp) => ({
      id: cp.id,
      name: cp.name,
      createdBy: cp.createdBy,
      creatorName: cp.creatorName,
      at: cp.at,
      seq: cp.seq,
      epoch: cp.epoch,
    }));
  }

  /** 房主打点：固化此刻完整权威状态；打点本身不占 seq、不改纪元 */
  async createCheckpoint(requesterId: string, rawName: string): Promise<Checkpoint> {
    const member = this.state.members.get(requesterId);
    assertCanManageHistory(member, requesterId, '创建存档点');
    const name = (rawName ?? '').trim();
    if (!name) throw new OpError('存档点名字不能为空');
    if (name.length > BOUNDS.maxCheckpointName)
      throw new OpError(`存档点名字过长（上限 ${BOUNDS.maxCheckpointName} 字）`);
    const cp: Checkpoint = {
      id: crypto.randomUUID(),
      canvasId: this.state.id,
      name,
      createdBy: requesterId,
      creatorName: member.name,
      at: Date.now(),
      seq: this.state.seq,
      epoch: this.epoch,
      state: canonicalState(this.state.shapes.values(), this.state.connectors.values(), this.state.members.values()),
    };
    this.checkpoints.push(cp);
    await this.store.saveCheckpoint(this.state.id, cp);
    return cp;
  }

  /**
   * 房主恢复：把权威状态整体切换成存档点内容。
   * - 与普通编辑共用同一条串行队列，恢复进行期间不会有别的写插入。
   * - 恢复本身占一个新 seq（kind='restore'），所有客户端凭 seq 确认。
   * - 纪元 +1：恢复后撤销/重做只作用于新纪元内本人的操作；
   *   中间那段操作日志一条不删，仍可再打新点、倒回任意更早/更晚的存档点。
   * - 存档内容自带完整连线（端点均为当时存在的图元），不会产生悬空连线。
   */
  async restoreCheckpoint(requesterId: string, checkpointId: string): Promise<{ entry: LogEntry; checkpoint: Checkpoint }> {
    const member = this.state.members.get(requesterId);
    assertCanManageHistory(member, requesterId, '恢复画布');
    if (typeof checkpointId !== 'string' || !checkpointId) throw new OpError('存档点 id 非法');
    const checkpoint = this.checkpoints.find((cp) => cp.id === checkpointId);
    if (!checkpoint) throw new OpError(`存档点 ${checkpointId} 不存在`);

    const before = canonicalState(this.state.shapes.values(), this.state.connectors.values(), this.state.members.values());
    const target = canonicalState(checkpoint.state.shapes, checkpoint.state.connectors, checkpoint.state.members);
    // 防御：若存档内容中出现悬空连线（理论上不可能），丢弃之，绝不把脏引用落库
    const targetShapeIds = new Set(target.shapes.map((s) => s.id));
    target.connectors = target.connectors.filter((c) => targetShapeIds.has(c.from) && targetShapeIds.has(c.to));

    const forward = diffStates(before, target);

    this.epoch += 1;
    // 不在此预应用状态：commit 在切换前状态上应用 forward 并派生对称 inverse
    const entry = await this.commit(
      requesterId,
      'restore',
      forward,
      `恢复到存档点「${checkpoint.name}」`,
      undefined,
      { checkpointId: checkpoint.id, checkpointName: checkpoint.name },
    );
    return { entry, checkpoint };
  }

  /* ---------------- 快照与增量 ---------------- */

  deltasSince(seq: number): LogEntry[] {
    return this.log.filter((e) => e.seq > seq);
  }
}
