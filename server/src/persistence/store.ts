/**
 * 持久化抽象：引擎只依赖 Store 接口。
 * 生产环境使用 PostgreSQL 实现（pgStore.ts），测试使用内存实现，
 * 两者语义一致：画布/图元/连线/成员/操作日志/存档点全量可恢复。
 */

import type { CheckpointState } from '../history.js';
import type { CheckpointMeta, Connector, LogEntry, Member, Shape } from '../types.js';

export interface PersistedCanvas {
  id: string;
  name: string;
  shapes: Shape[];
  connectors: Connector[];
  members: Member[];
  ops: LogEntry[];
}

/** 一份落盘的存档点：元信息 + 打点那一刻的规范化完整画布状态（不可变） */
export interface StoredCheckpoint {
  meta: CheckpointMeta;
  state: CheckpointState;
}

export interface Store {
  ensureCanvas(id: string, name: string): Promise<void>;
  loadCanvas(id: string): Promise<PersistedCanvas | null>;

  upsertMember(canvasId: string, member: Member): Promise<void>;
  deleteMember(canvasId: string, userId: string): Promise<void>;

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

  saveCheckpoint(canvasId: string, checkpoint: StoredCheckpoint): Promise<void>;
  loadCheckpoints(canvasId: string): Promise<StoredCheckpoint[]>;

  close(): Promise<void>;
}

/** 内存实现：供单元/集成测试与无数据库的本地开发使用 */
export class MemoryStore implements Store {
  private canvases = new Map<string, PersistedCanvas>();
  private checkpoints = new Map<string, StoredCheckpoint[]>();

  async ensureCanvas(id: string, name: string): Promise<void> {
    if (!this.canvases.has(id)) {
      this.canvases.set(id, { id, name, shapes: [], connectors: [], members: [], ops: [] });
    }
    if (!this.checkpoints.has(id)) this.checkpoints.set(id, []);
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

  async deleteMember(canvasId: string, userId: string): Promise<void> {
    const c = this.must(canvasId);
    c.members = c.members.filter((m) => m.userId !== userId);
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
    this.must(canvasId).ops.push(structuredClone(entry));
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

  async saveCheckpoint(canvasId: string, checkpoint: StoredCheckpoint): Promise<void> {
    this.must(canvasId);
    const list = this.checkpoints.get(canvasId)!;
    // 存档点不可变：同 id 已存在时拒绝覆盖（id 由引擎生成，正常不会冲突）
    if (list.some((c) => c.meta.id === checkpoint.meta.id)) {
      throw new Error(`存档点 ${checkpoint.meta.id} 已存在`);
    }
    list.push(structuredClone(checkpoint));
  }

  async loadCheckpoints(canvasId: string): Promise<StoredCheckpoint[]> {
    return structuredClone(this.checkpoints.get(canvasId) ?? []);
  }

  async close(): Promise<void> {}
}
