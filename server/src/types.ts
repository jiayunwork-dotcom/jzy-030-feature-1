/**
 * 共享类型与线协议（客户端/服务端消息）定义。
 * 前端 web/src/types.ts 与此文件保持同构。
 */

export type Role = 'owner' | 'editor' | 'viewer';

export type ShapeKind = 'rect' | 'ellipse' | 'note';

export interface Shape {
  id: string;
  kind: ShapeKind;
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
  color: string;
  text: string;
}

/** 图元可被 patch 的属性集合（撤销/并发合并的属性级粒度） */
export interface ShapeAttrs {
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  z?: number;
  color?: string;
  text?: string;
}

export type AnchorSide = 'n' | 'e' | 's' | 'w';

export interface Connector {
  id: string;
  from: string; // 源图元 id
  to: string; // 目标图元 id
  fromSide: AnchorSide;
  toSide: AnchorSide;
  /** 扁平化折线点 [x1, y1, x2, y2, ...]，由服务端路由模块计算 */
  path: number[];
}

export interface Member {
  userId: string;
  name: string;
  role: Role;
  color: string;
}

export interface CanvasState {
  id: string;
  seq: number;
  shapes: Map<string, Shape>;
  connectors: Map<string, Connector>;
  members: Map<string, Member>;
}

/** 客户端发起的操作（属性级，绝对值语义，保证可重放收敛） */
export type Op =
  | {
      kind: 'shape.create';
      shape: {
        id: string;
        kind: ShapeKind;
        x: number;
        y: number;
        w: number;
        h: number;
        z?: number;
        color?: string;
        text?: string;
      };
    }
  | { kind: 'shape.set'; shapeId: string; attrs: ShapeAttrs }
  | { kind: 'shape.delete'; shapeId: string }
  | { kind: 'connector.create'; id: string; from: string; to: string }
  | { kind: 'connector.delete'; connectorId: string };

export interface ShapePatch {
  id: string;
  attrs: ShapeAttrs;
}

/**
 * 一次状态变更的效果集：所有广播/日志/撤销都以 effects 表达，
 * 客户端只需无脑应用 upsert/patch/delete 即可收敛。
 */
export interface Effects {
  upsertShapes?: Shape[];
  patchShapes?: ShapePatch[];
  deleteShapeIds?: string[];
  upsertConnectors?: Connector[];
  deleteConnectorIds?: string[];
  /** 仅"恢复到存档点"这类跨成员的整体状态跳变使用：成员集合整体对齐 */
  upsertMembers?: Member[];
  deleteMemberIds?: string[];
}

/**
 * 存档点元信息：内容不可变，id 稳定（重连/重启后仍指向同一份历史）。
 * state（打点那一刻的完整画布）持久化在 checkpoints 表，见 history.ts。
 */
export interface CheckpointMeta {
  id: string;
  canvasId: string;
  name: string;
  createdBy: string;
  createdByName: string;
  createdAt: number;
  /** 打点时操作序列的位置：该存档点记录的是此 seq 时刻的权威状态 */
  seq: number;
}

/** 操作日志条目：forward/inverse 成对存储，撤销即应用 inverse */
export interface LogEntry {
  seq: number;
  userId: string;
  /**
   * normal：普通编辑；undo/redo：按人撤销重做；
   * restore：恢复到存档点（跨所有人的整体状态跳变，占一个新 seq，
   * 并成为撤销/重做的屏障——屏障之前的条目不可再被撤销/重做）。
   */
  kind: 'normal' | 'undo' | 'redo' | 'restore';
  /** 正向效果（已含连线重算等派生变更） */
  forward: Effects;
  /** 逆向效果（撤销时应用） */
  inverse: Effects;
  /** undo/redo 指向的 normal 条目 seq */
  targetSeq?: number;
  /** 仅 normal 条目有意义：是否已被撤销 */
  undone: boolean;
  /** 被哪条 undo 条目撤销 */
  undoneBy?: number;
  /** 被撤销后是否仍可重做（用户产生新 normal 操作后置 false） */
  redoable: boolean;
  at: number;
  /** 人类可读描述，用于调试与 UI 提示 */
  label: string;
}

export interface Snapshot {
  canvasId: string;
  seq: number;
  shapes: Shape[];
  connectors: Connector[];
  members: Member[];
}

export interface PresenceState {
  userId: string;
  cursor: { x: number; y: number } | null;
  selection: string[];
}

/* ---------------- 客户端 -> 服务端 ---------------- */

export type ClientMessage =
  | { type: 'hello'; canvasId: string; userId: string; name: string; lastSeq?: number }
  | { type: 'op'; clientOpId: string; op: Op }
  | { type: 'undo'; clientOpId: string }
  | { type: 'redo'; clientOpId: string }
  | { type: 'preview'; shapes: Shape[] }
  | { type: 'preview.end' }
  | { type: 'presence'; cursor: { x: number; y: number } | null; selection: string[] }
  | { type: 'role.set'; userId: string; role: Role }
  | { type: 'checkpoint.create'; clientOpId: string; name: string }
  | { type: 'checkpoint.restore'; clientOpId: string; checkpointId: string };

/* ---------------- 服务端 -> 客户端 ---------------- */

export type ServerMessage =
  | {
      type: 'welcome';
      canvasId: string;
      you: Member;
      seq: number;
      snapshot: Snapshot;
      /** lastSeq 之后的增量（断线续传），按 seq 升序 */
      deltas: { seq: number; userId: string; kind: LogEntry['kind']; forward: Effects }[];
      presence: PresenceState[];
      /** 当前画布的全部存档点（所有在线成员可见） */
      checkpoints: CheckpointMeta[];
    }
  | { type: 'op'; seq: number; userId: string; kind: LogEntry['kind']; forward: Effects; label: string }
  | { type: 'op.ack'; clientOpId: string; seq: number }
  | {
      type: 'op.reject';
      clientOpId: string;
      reason: string;
      /** 权威状态，客户端据此回滚 */
      shapes?: Shape[];
      connectors?: Connector[];
    }
  | { type: 'preview'; userId: string; shapes: Shape[] }
  | { type: 'preview.clear'; userId: string; shapes: Shape[] }
  | { type: 'presence'; presence: PresenceState }
  | { type: 'presence.clear'; userId: string }
  | { type: 'role.changed'; member: Member }
  | { type: 'member.joined'; member: Member }
  /** 存档点创建成功：广播给打点者之外的在线成员 */
  | { type: 'checkpoint.created'; checkpoint: CheckpointMeta }
  /** 打点者收到的确认（与 checkpoint.created 内容一致，带 clientOpId 便于关联） */
  | { type: 'checkpoint.ack'; clientOpId: string; checkpoint: CheckpointMeta }
  /** 打点/恢复被拒绝（非房主、存档点不存在等），reason 为人类可读原因 */
  | { type: 'checkpoint.reject'; clientOpId: string; reason: string }
  /**
   * 恢复完成：一次性广播给所有在线客户端（含发起者）。
   * 携带恢复后的完整权威快照与新占的序列位置 seq，
   * 客户端整体对齐到快照，不进行中的交互一律作废回弹。
   */
  | { type: 'restored'; seq: number; checkpoint: CheckpointMeta; by: string; snapshot: Snapshot }
  | { type: 'error'; reason: string };

/** 画布坐标/尺寸合法范围（越界写将被拒绝） */
export const BOUNDS = {
  minX: 0,
  maxX: 4000,
  minY: 0,
  maxY: 4000,
  minW: 20,
  maxW: 2000,
  minH: 20,
  maxH: 2000,
  maxZ: 1_000_000,
  maxText: 500,
} as const;
