/**
 * 持久化抽象：引擎只依赖 Store 接口。
 * 生产环境使用 PostgreSQL 实现（pgStore.ts），测试使用内存实现，
 * 两者语义一致：画布/图元/连线/成员/操作日志全量可恢复。
 */

import type { Checkpoint, Connector, LogEntry, Member, Shape } from '../types.js';

export interface PersistedCanvas {
  id: string;
  name: string;
  shapes: Shape[];
  connectors: Connector[];
  members: Member[];
  ops: LogEntry[];
  checkpoints: Checkpoint[];
}

export interface Store {
  ensureCanvas(id: string, name: string): Promise<void>;
  loadCanvas(id: string): Promise<PersistedCanvas | null>;

  upsertMember(canvasId: string, member: Member): Promise<void>;

  upsertShape(canvasId: string, shape: Shape): Promise<void>;
  deleteShape(canvasId: string, shapeId: string): Promise<void>;

  upsertConnector(canvasId: string, connector: Connector): Promise<void>;
  deleteConnector(canvasId: string, connectorId: string): Promise<void>;

  appendOp(canvasId: string, entry: LogEntry): Promise<void>;
  updateOpFlags(
    canvasId: string,
    seq: number,
    flags: { undone?: boolean; undoneBy?: number | null; redoable?: boolean },
  ): Promise<void>;

  /** 存档点只增不改不删（不可变历史） */
  saveCheckpoint(canvasId: string, checkpoint: Checkpoint): Promise<void>;
  listCheckpoints(canvasId: string): Promise<Checkpoint[]>;

  close(): Promise<void>;
}

/** 内存实现：供单元/集成测试与无数据库的本地开发使用 */
export class MemoryStore implements Store {
  private canvases = new Map<string, PersistedCanvas>();

  async ensureCanvas(id: string, name: string): Promise<void> {
    if (!this.canvases.has(id)) {
      this.canvases.set(id, { id, name, shapes: [], connectors: [], members: [], ops: [], checkpoints: [] });
    }
  }

  async loadCanvas(id: string): Promise<PersistedCanvas | null> {
    const c = this.canvases.get(id);
    if (!c) return null;
    // 深拷贝，模拟真实数据库的隔离语义
    return structuredClone(c);
  }

  private must(id: string): PersistedCanvas {
    const c = this.canvases.get(id);
    if (!c) throw new Error(`canvas ${id} 不存在`);
    return c;
  }

  async upsertMember(canvasId: string, member: Member): Promise<void> {
    const c = this.must(canvasId);
    const i = c.members.findIndex((m) => m.userId === member.userId);
    if (i >= 0) c.members[i] = structuredClone(member);
    else c.members.push(structuredClone(member));
  }

  async upsertShape(canvasId: string, shape: Shape): Promise<void> {
    const c = this.must(canvasId);
    const i = c.shapes.findIndex((s) => s.id === shape.id);
    if (i >= 0) c.shapes[i] = structuredClone(shape);
    else c.shapes.push(structuredClone(shape));
  }

  async deleteShape(canvasId: string, shapeId: string): Promise<void> {
    const c = this.must(canvasId);
    c.shapes = c.shapes.filter((s) => s.id !== shapeId);
  }

  async upsertConnector(canvasId: string, connector: Connector): Promise<void> {
    const c = this.must(canvasId);
    const i = c.connectors.findIndex((k) => k.id === connector.id);
    if (i >= 0) c.connectors[i] = structuredClone(connector);
    else c.connectors.push(structuredClone(connector));
  }

  async deleteConnector(canvasId: string, connectorId: string): Promise<void> {
    const c = this.must(canvasId);
    c.connectors = c.connectors.filter((k) => k.id !== connectorId);
  }

  async appendOp(canvasId: string, entry: LogEntry): Promise<void> {
    const c = this.must(canvasId);
    c.ops.push(structuredClone(entry));
    // restore 条目：实体内容随日志同一切换（与 PgStore 的单事务语义一致）
    if (entry.kind === 'restore') {
      const fx = entry.forward;
      for (const s of fx.upsertShapes ?? []) {
        const i = c.shapes.findIndex((x) => x.id === s.id);
        if (i >= 0) c.shapes[i] = structuredClone(s);
        else c.shapes.push(structuredClone(s));
      }
      for (const id of fx.deleteShapeIds ?? []) c.shapes = c.shapes.filter((x) => x.id !== id);
      for (const k of fx.upsertConnectors ?? []) {
        const i = c.connectors.findIndex((x) => x.id === k.id);
        if (i >= 0) c.connectors[i] = structuredClone(k);
        else c.connectors.push(structuredClone(k));
      }
      for (const id of fx.deleteConnectorIds ?? []) c.connectors = c.connectors.filter((x) => x.id !== id);
      for (const m of fx.upsertMembers ?? []) {
        const i = c.members.findIndex((x) => x.userId === m.userId);
        if (i >= 0) c.members[i] = structuredClone(m);
        else c.members.push(structuredClone(m));
      }
      for (const userId of fx.deleteMemberIds ?? []) c.members = c.members.filter((x) => x.userId !== userId);
    }
  }

  async updateOpFlags(
    canvasId: string,
    seq: number,
    flags: { undone?: boolean; undoneBy?: number | null; redoable?: boolean },
  ): Promise<void> {
    const op = this.must(canvasId).ops.find((o) => o.seq === seq);
    if (!op) return;
    if (flags.undone !== undefined) op.undone = flags.undone;
    if (flags.undoneBy !== undefined) op.undoneBy = flags.undoneBy === null ? undefined : flags.undoneBy;
    if (flags.redoable !== undefined) op.redoable = flags.redoable;
  }

  async saveCheckpoint(canvasId: string, checkpoint: Checkpoint): Promise<void> {
    this.must(canvasId).checkpoints.push(structuredClone(checkpoint));
  }

  async listCheckpoints(canvasId: string): Promise<Checkpoint[]> {
    return structuredClone(this.must(canvasId).checkpoints);
  }

  async close(): Promise<void> {}
}
