/**
 * 协作者状态层：
 * - 维护画布权威状态的本地镜像（快照 + 服务端广播的 effects 增量）。
 * - 拖拽/缩放为"本地临时态 + 预览广播"，松手才提交属性级操作；
 *   若拖动中被降级为只读，立即回滚到拖动前位置，且不再发出任何写。
 * - 操作被拒绝时用回包中的权威状态回滚本地，并弹出可读原因。
 * - 维护其他协作者的光标与选中框（presence）以及他们的拖动预览。
 */

import { CollabClient } from './client';
import type {
  CheckpointInfo,
  Connector,
  Effects,
  Member,
  Op,
  PresenceState,
  Role,
  ServerMessage,
  Shape,
  ShapeAttrs,
} from '../types';

export type Tool = 'select' | 'rect' | 'ellipse' | 'note' | 'connect';

export interface Toast {
  id: number;
  text: string;
}

interface DragState {
  shapeId: string;
  mode: 'move' | 'resize';
  startX: number;
  startY: number;
  origin: Shape;
  moved: boolean;
}

const CANVAS_ID = 'main';

function getUserId(): string {
  let id = localStorage.getItem('collab.userId');
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem('collab.userId', id);
  }
  return id;
}

function getUserName(): string {
  let name = localStorage.getItem('collab.userName');
  if (!name) {
    name = `用户-${Math.random().toString(36).slice(2, 6)}`;
    localStorage.setItem('collab.userName', name);
  }
  return name;
}

export class WhiteboardStore {
  shapes = new Map<string, Shape>();
  connectors = new Map<string, Connector>();
  members = new Map<string, Member>();
  presence = new Map<string, PresenceState>();
  /** 其他用户拖动中的临时位置（userId -> 图元快照），不进入权威状态 */
  previews = new Map<string, Shape[]>();
  /** 历史存档点（不可变，只增） */
  checkpoints: CheckpointInfo[] = [];
  /** 当前时间线纪元，随服务端恢复广播整体对齐 */
  epoch = 0;
  self: Member | null = null;
  connected = false;
  tool: Tool = 'select';
  selection: string[] = [];
  connectSource: string | null = null;
  toasts: Toast[] = [];
  /** 每次状态变化自增，供 useSyncExternalStore 做快照 */
  version = 0;

  private client: CollabClient;
  private listeners = new Set<() => void>();
  private drag: DragState | null = null;
  private opCounter = 0;
  private toastCounter = 0;
  private previewThrottle = 0;
  private presenceThrottle = 0;

  constructor() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    this.client = new CollabClient(
      `${proto}://${location.host}/ws`,
      () => ({ type: 'hello', canvasId: CANVAS_ID, userId: getUserId(), name: getUserName() }),
      {
        onMessage: (msg) => this.handleMessage(msg),
        onConnectionChange: (connected) => {
          this.connected = connected;
          if (!connected) this.previews.clear();
          this.emit();
        },
      },
    );
  }

  connect() {
    this.client.connect();
  }

  /* ---------------- React 订阅 ---------------- */

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private emit() {
    this.version++;
    for (const fn of this.listeners) fn();
  }

  get canEdit(): boolean {
    return this.self?.role === 'owner' || this.self?.role === 'editor';
  }

  /* ---------------- 消息处理 ---------------- */

  private handleMessage(msg: ServerMessage) {
    switch (msg.type) {
      case 'welcome': {
        this.self = msg.you;
        this.replaceAll(msg.snapshot);
        this.presence.clear();
        for (const p of msg.presence) this.presence.set(p.userId, p);
        this.previews.clear();
        // 重连期间可能正拖着动作：快照是权威，本地半截拖动直接作废（不回写，快照整体替换）
        this.discardDrag();
        this.emit();
        break;
      }
      case 'op': {
        this.applyEffects(msg.forward);
        // 权威状态到达，清掉对应用户的拖动预览
        if (msg.forward.patchShapes?.length || msg.forward.upsertShapes?.length) {
          this.previews.delete(msg.userId);
        }
        // 恢复类广播不会走这里（restore 单独处理）
        this.emit();
        break;
      }
      case 'op.reject': {
        // 用权威状态回滚本地，画面回到服务端状态
        for (const s of msg.shapes ?? []) this.shapes.set(s.id, s);
        for (const c of msg.connectors ?? []) this.connectors.set(c.id, c);
        if (this.drag && !this.canEdit) this.rollbackDrag();
        this.toast(`操作被拒绝：${msg.reason}`);
        this.emit();
        break;
      }
      case 'checkpoint.created': {
        // 列表只增：重复 id（极端重发）不重复添加
        if (!this.checkpoints.some((c) => c.id === msg.checkpoint.id)) {
          this.checkpoints = [...this.checkpoints, msg.checkpoint].sort((a, b) => a.at - b.at || a.seq - b.seq);
          this.emit();
        }
        break;
      }
      case 'restore': {
        // 整画布恢复：不本地拼差异，直接用服务端快照整体对齐
        // （图元位置、连线走向、成员角色一次刷新；进行中的交互打断回弹）
        this.discardDrag();
        this.previews.clear();
        this.replaceAll(msg.snapshot);
        this.selection = this.selection.filter((id) => this.shapes.has(id));
        this.connectSource = null;
        this.toast(`画布已由${msg.userId === this.self?.userId ? '你' : '房主'}恢复到存档点「${msg.checkpointName}」`);
        this.emit();
        break;
      }
      case 'preview': {
        this.previews.set(msg.userId, msg.shapes);
        this.emit();
        break;
      }
      case 'preview.clear': {
        this.previews.delete(msg.userId);
        for (const s of msg.shapes) this.shapes.set(s.id, s);
        this.emit();
        break;
      }
      case 'presence': {
        if (msg.presence.userId !== this.self?.userId) {
          this.presence.set(msg.presence.userId, msg.presence);
          this.emit();
        }
        break;
      }
      case 'presence.clear': {
        this.presence.delete(msg.userId);
        this.emit();
        break;
      }
      case 'role.changed': {
        this.members.set(msg.member.userId, msg.member);
        if (msg.member.userId === this.self?.userId) {
          this.self = msg.member;
          if (msg.member.role === 'viewer') {
            // 降级立即生效：进行中的拖动马上回滚，不提交、不广播脏位置
            this.rollbackDrag();
            this.toast('你已被房主调整为只读，进行中的编辑已回滚');
          }
        }
        this.emit();
        break;
      }
      case 'member.joined': {
        this.members.set(msg.member.userId, msg.member);
        this.emit();
        break;
      }
      case 'error': {
        this.toast(msg.reason);
        break;
      }
      default:
        break;
    }
  }

  private applyEffects(fx: Effects) {
    for (const s of fx.upsertShapes ?? []) this.shapes.set(s.id, s);
    for (const p of fx.patchShapes ?? []) {
      const shape = this.shapes.get(p.id);
      if (shape) Object.assign(shape, p.attrs);
    }
    for (const id of fx.deleteShapeIds ?? []) {
      this.shapes.delete(id);
      this.selection = this.selection.filter((s) => s !== id);
    }
    for (const c of fx.upsertConnectors ?? []) this.connectors.set(c.id, c);
    for (const id of fx.deleteConnectorIds ?? []) this.connectors.delete(id);
    for (const m of fx.upsertMembers ?? []) {
      const isSelf = m.userId === this.self?.userId;
      this.members.set(m.userId, m);
      if (isSelf) this.self = m;
    }
    for (const id of fx.deleteMemberIds ?? []) this.members.delete(id);
  }

  /** 用服务端完整快照整体替换本地权威镜像（welcome/restore 共用） */
  private replaceAll(snapshot: { shapes: Shape[]; connectors: Connector[]; members: Member[]; checkpoints: CheckpointInfo[]; epoch: number }) {
    this.shapes.clear();
    this.connectors.clear();
    this.members.clear();
    for (const s of snapshot.shapes) this.shapes.set(s.id, s);
    for (const c of snapshot.connectors) this.connectors.set(c.id, c);
    for (const m of snapshot.members) this.members.set(m.userId, m);
    this.checkpoints = [...snapshot.checkpoints].sort((a, b) => a.at - b.at || a.seq - b.seq);
    this.epoch = snapshot.epoch;
    if (this.self) {
      const me = this.members.get(this.self.userId);
      if (me) this.self = me;
    }
  }

  /** 打断进行中的拖动/连线交互：丢弃本地临时态（权威回弹由随后的消息负责） */
  private cancelDrag() {
    if (!this.drag) return;
    const d = this.drag;
    this.drag = null;
    const shape = this.shapes.get(d.shapeId);
    if (shape) Object.assign(shape, { x: d.origin.x, y: d.origin.y, w: d.origin.w, h: d.origin.h });
    this.client.send({ type: 'preview.end' });
  }

  /**
   * 丢弃进行中的拖动但不回写坐标——紧接着会有服务端完整快照整体替换本地
   * （welcome/restore），回写过期原点反而会盖掉权威值。
   */
  private discardDrag() {
    if (this.drag) {
      this.drag = null;
      this.client.send({ type: 'preview.end' });
    }
  }

  /* ---------------- 操作发送（乐观应用 + 拒绝回滚） ---------------- */

  private nextOpId() {
    return `op-${Date.now()}-${++this.opCounter}`;
  }

  private sendOp(op: Op, optimistic?: Effects) {
    if (!this.canEdit) {
      this.toast('当前为只读角色，无法编辑');
      return;
    }
    if (optimistic) this.applyEffects(optimistic);
    this.client.send({ type: 'op', clientOpId: this.nextOpId(), op });
    this.emit();
  }

  undo() {
    if (!this.canEdit) return this.toast('当前为只读角色，无法撤销');
    this.client.send({ type: 'undo', clientOpId: this.nextOpId() });
  }

  redo() {
    if (!this.canEdit) return this.toast('当前为只读角色，无法重做');
    this.client.send({ type: 'redo', clientOpId: this.nextOpId() });
  }

  setRole(userId: string, role: Role) {
    this.client.send({ type: 'role.set', userId, role });
  }

  /* ---------------- 历史存档点 ---------------- */

  get isOwner(): boolean {
    return this.self?.role === 'owner';
  }

  /** 房主打点；非房主在 UI 上入口禁用，绕过 UI 发起时服务端也会拒绝 */
  createCheckpoint(name: string) {
    const trimmed = name.trim();
    if (!trimmed) return this.toast('存档点名字不能为空');
    if (!this.isOwner) return this.toast('仅房主可以创建存档点');
    this.client.send({ type: 'checkpoint.create', clientOpId: this.nextOpId(), name: trimmed });
  }

  restoreCheckpoint(checkpointId: string) {
    if (!this.isOwner) return this.toast('仅房主可以恢复画布到存档点');
    this.client.send({ type: 'checkpoint.restore', clientOpId: this.nextOpId(), checkpointId });
  }

  rename(name: string) {
    localStorage.setItem('collab.userName', name);
    // 重新建立连接以更新名字
    this.client.close();
    this.client.connect();
  }

  /* ---------------- 工具与选择 ---------------- */

  setTool(tool: Tool) {
    this.tool = tool;
    this.connectSource = null;
    this.emit();
  }

  select(ids: string[]) {
    this.selection = ids;
    this.sendPresence();
    this.emit();
  }

  createShape(kind: 'rect' | 'ellipse' | 'note', x: number, y: number, w: number, h: number) {
    const id = crypto.randomUUID();
    const shape: Shape = {
      id,
      kind,
      x: Math.round(x),
      y: Math.round(y),
      w: Math.round(w),
      h: Math.round(h),
      z: 0,
      color: kind === 'note' ? '#fde047' : kind === 'rect' ? '#93c5fd' : '#86efac',
      text: kind === 'note' ? '双击编辑便签' : '',
    };
    this.sendOp(
      { kind: 'shape.create', shape: { id, kind, x: shape.x, y: shape.y, w: shape.w, h: shape.h, color: shape.color, text: shape.text } },
      { upsertShapes: [shape] },
    );
    this.selection = [id];
    this.setTool('select');
  }

  deleteSelection() {
    if (!this.canEdit) return this.toast('当前为只读角色，无法删除');
    for (const id of this.selection) {
      const attached = [...this.connectors.values()].filter((c) => c.from === id || c.to === id).map((c) => c.id);
      this.sendOp(
        { kind: 'shape.delete', shapeId: id },
        { deleteShapeIds: [id], deleteConnectorIds: attached },
      );
    }
    this.selection = [];
  }

  setColorForSelection(color: string) {
    for (const id of this.selection) {
      this.sendOp({ kind: 'shape.set', shapeId: id, attrs: { color } }, { patchShapes: [{ id, attrs: { color } }] });
    }
  }

  editText(id: string) {
    const shape = this.shapes.get(id);
    if (!shape) return;
    if (!this.canEdit) return this.toast('当前为只读角色，无法编辑文本');
    const text = window.prompt('编辑文本', shape.text);
    if (text === null || text === shape.text) return;
    this.sendOp({ kind: 'shape.set', shapeId: id, attrs: { text } }, { patchShapes: [{ id, attrs: { text } }] });
  }

  /* ---------------- 连线 ---------------- */

  clickConnect(shapeId: string) {
    if (!this.canEdit) return this.toast('当前为只读角色，无法连线');
    if (!this.connectSource) {
      this.connectSource = shapeId;
      this.emit();
      return;
    }
    if (this.connectSource === shapeId) {
      this.connectSource = null;
      this.emit();
      return;
    }
    const id = crypto.randomUUID();
    this.sendOp({ kind: 'connector.create', id, from: this.connectSource, to: shapeId });
    this.connectSource = null;
    this.setTool('select');
  }

  /* ---------------- 拖拽（移动/缩放），降级立即回滚 ---------------- */

  beginDrag(shapeId: string, mode: 'move' | 'resize', px: number, py: number) {
    if (!this.canEdit) return;
    const shape = this.shapes.get(shapeId);
    if (!shape) return;
    this.drag = { shapeId, mode, startX: px, startY: py, origin: structuredClone(shape), moved: false };
  }

  updateDrag(px: number, py: number) {
    const d = this.drag;
    if (!d) return;
    if (!this.canEdit) return this.rollbackDrag(); // 拖动中被降级
    const shape = this.shapes.get(d.shapeId);
    if (!shape) return this.rollbackDrag();
    const dx = px - d.startX;
    const dy = py - d.startY;
    if (d.mode === 'move') {
      shape.x = Math.round(d.origin.x + dx);
      shape.y = Math.round(d.origin.y + dy);
    } else {
      shape.w = Math.max(20, Math.round(d.origin.w + dx));
      shape.h = Math.max(20, Math.round(d.origin.h + dy));
    }
    d.moved = true;
    // 临时预览广播（ephemeral，不进入日志），让协作者实时看到拖动过程
    const now = Date.now();
    if (now - this.previewThrottle > 50) {
      this.previewThrottle = now;
      this.client.send({ type: 'preview', shapes: [structuredClone(shape)] });
    }
    this.emit();
  }

  endDrag() {
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    this.client.send({ type: 'preview.end' });
    if (!d.moved) return;
    const shape = this.shapes.get(d.shapeId);
    if (!shape) return;
    if (!this.canEdit) {
      // 降级发生在松手前一刻：回滚，不提交
      Object.assign(shape, d.origin);
      this.emit();
      return;
    }
    const attrs: ShapeAttrs =
      d.mode === 'move' ? { x: shape.x, y: shape.y } : { w: shape.w, h: shape.h };
    // 本地已是目标位置（乐观），提交后等待权威确认；被拒绝时由 op.reject 回滚
    this.client.send({ type: 'op', clientOpId: this.nextOpId(), op: { kind: 'shape.set', shapeId: d.shapeId, attrs } });
    this.emit();
  }

  private rollbackDrag() {
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    const shape = this.shapes.get(d.shapeId);
    if (shape) Object.assign(shape, { x: d.origin.x, y: d.origin.y, w: d.origin.w, h: d.origin.h });
    this.client.send({ type: 'preview.end' });
    this.emit();
  }

  isDragging(): boolean {
    return this.drag !== null;
  }

  /* ---------------- presence ---------------- */

  sendCursor(x: number, y: number) {
    const now = Date.now();
    if (now - this.presenceThrottle < 40) return;
    this.presenceThrottle = now;
    this.client.send({ type: 'presence', cursor: { x: Math.round(x), y: Math.round(y) }, selection: this.selection });
  }

  sendPresence() {
    this.client.send({ type: 'presence', cursor: null, selection: this.selection });
  }

  /* ---------------- toast ---------------- */

  toast(text: string) {
    const id = ++this.toastCounter;
    this.toasts = [...this.toasts, { id, text }];
    this.emit();
    window.setTimeout(() => {
      this.toasts = this.toasts.filter((t) => t.id !== id);
      this.emit();
    }, 4000);
  }
}
