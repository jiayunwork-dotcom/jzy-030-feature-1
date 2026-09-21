/**
 * 连接与广播层：
 * - 管理 WebSocket 连接、房间（画布）成员、在线光标/选中框（presence）、
 *   拖动中的临时预览（preview， ephemeral，不落库不进日志）。
 * - 写操作（op/undo/redo）一律经引擎串行定序后广播 effects；
 *   拒绝时回包携带权威状态，客户端据此回滚到服务端状态。
 * - 角色降级立即生效：广播 role.changed，并清除被降级者的预览、
 *   用权威图元状态覆盖，其后续写操作一律被拒绝。
 */

import type { WebSocket } from 'ws';
import { Engine } from './engine.js';
import { OpError, canEdit } from './permissions.js';
import type { Store } from './persistence/store.js';
import { buildSnapshot, deltasSince } from './snapshot.js';
import type {
  ClientMessage,
  Connector,
  Op,
  PresenceState,
  ServerMessage,
  Shape,
} from './types.js';

interface Conn {
  ws: WebSocket;
  userId: string;
  canvasId: string;
}

class Room {
  conns = new Set<Conn>();
  presence = new Map<string, PresenceState>();
  /** userId -> 正在预览的图元 id 集合（用于降级/断线时清除并回滚） */
  previews = new Map<string, Set<string>>();
}

export class CollabServer {
  private engines = new Map<string, Promise<Engine>>();
  private rooms = new Map<string, Room>();

  constructor(
    private store: Store,
    private defaultCanvasName = 'main',
  ) {}

  getEngine(canvasId: string): Promise<Engine> {
    let p = this.engines.get(canvasId);
    if (!p) {
      p = Engine.load(this.store, canvasId, canvasId === 'main' ? this.defaultCanvasName : canvasId);
      this.engines.set(canvasId, p);
    }
    return p;
  }

  private room(canvasId: string): Room {
    let r = this.rooms.get(canvasId);
    if (!r) {
      r = new Room();
      this.rooms.set(canvasId, r);
    }
    return r;
  }

  private send(ws: WebSocket, msg: ServerMessage) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }

  private broadcast(canvasId: string, msg: ServerMessage, except?: Conn) {
    const room = this.rooms.get(canvasId);
    if (!room) return;
    const data = JSON.stringify(msg);
    for (const c of room.conns) {
      if (c !== except && c.ws.readyState === c.ws.OPEN) c.ws.send(data);
    }
  }

  async handleConnection(ws: WebSocket) {
    const conn: Conn = { ws, userId: '', canvasId: '' };
    ws.on('message', (raw) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        this.send(ws, { type: 'error', reason: '消息不是合法 JSON' });
        return;
      }
      this.handleMessage(conn, msg).catch((err) => {
        console.error('[connection] 处理消息出错:', err);
        this.send(ws, { type: 'error', reason: '服务器内部错误' });
      });
    });
    ws.on('close', () => this.handleClose(conn));
  }

  private async handleMessage(conn: Conn, msg: ClientMessage) {
    switch (msg.type) {
      case 'hello':
        return this.handleHello(conn, msg);
      case 'op':
        return this.handleOp(conn, msg.clientOpId, msg.op);
      case 'undo':
        return this.handleUndoRedo(conn, msg.clientOpId, 'undo');
      case 'redo':
        return this.handleUndoRedo(conn, msg.clientOpId, 'redo');
      case 'preview':
        return this.handlePreview(conn, msg.shapes);
      case 'preview.end':
        return this.handlePreviewEnd(conn);
      case 'presence':
        return this.handlePresence(conn, msg);
      case 'role.set':
        return this.handleRoleSet(conn, msg.userId, msg.role);
      default:
        this.send(conn.ws, { type: 'error', reason: `未知消息类型: ${(msg as { type: string }).type}` });
    }
  }

  private async handleHello(conn: Conn, msg: Extract<ClientMessage, { type: 'hello' }>) {
    const canvasId = msg.canvasId || 'main';
    const engine = await this.getEngine(canvasId);
    const { member, isNew } = await engine.enqueue(() => engine.join(msg.userId, msg.name));
    conn.userId = msg.userId;
    conn.canvasId = canvasId;
    this.room(canvasId).conns.add(conn);

    const lastSeq = typeof msg.lastSeq === 'number' ? msg.lastSeq : -1;
    this.send(conn.ws, {
      type: 'welcome',
      canvasId,
      you: member,
      seq: engine.state.seq,
      snapshot: buildSnapshot(engine),
      deltas: lastSeq >= 0 ? deltasSince(engine, lastSeq) : [],
      presence: [...this.room(canvasId).presence.values()].filter((p) => p.userId !== msg.userId),
    });
    if (isNew) this.broadcast(canvasId, { type: 'member.joined', member }, conn);
  }

  /** 从操作本身提取涉及实体，拒绝时回传权威状态 */
  private entitiesOfOp(engine: Engine, op: Op): { shapes?: Shape[]; connectors?: Connector[] } {
    const shapeIds: string[] = [];
    const connectorIds: string[] = [];
    switch (op.kind) {
      case 'shape.create':
        shapeIds.push(op.shape.id);
        break;
      case 'shape.set':
      case 'shape.delete':
        shapeIds.push(op.shapeId);
        for (const c of engine.state.connectors.values())
          if (c.from === op.shapeId || c.to === op.shapeId) connectorIds.push(c.id);
        break;
      case 'connector.create':
        connectorIds.push(op.id);
        shapeIds.push(op.from, op.to);
        break;
      case 'connector.delete':
        connectorIds.push(op.connectorId);
        break;
    }
    const shapes = shapeIds
      .map((id) => engine.state.shapes.get(id))
      .filter((s): s is Shape => Boolean(s));
    const connectors = connectorIds
      .map((id) => engine.state.connectors.get(id))
      .filter((c): c is Connector => Boolean(c));
    return { shapes, connectors };
  }

  private async handleOp(conn: Conn, clientOpId: string, op: Op) {
    if (!conn.userId) return this.send(conn.ws, { type: 'op.reject', clientOpId, reason: '尚未加入画布' });
    const engine = await this.getEngine(conn.canvasId);
    try {
      const entry = await engine.enqueue(() => engine.applyOp(conn.userId, op));
      this.send(conn.ws, { type: 'op.ack', clientOpId, seq: entry.seq });
      this.broadcast(conn.canvasId, {
        type: 'op',
        seq: entry.seq,
        userId: entry.userId,
        kind: entry.kind,
        forward: entry.forward,
        label: entry.label,
      });
      // 提交成功后该用户的拖动预览即被权威状态取代
      this.clearPreview(conn, false);
    } catch (err) {
      const reason = err instanceof OpError ? err.message : '操作被拒绝';
      const entities = this.entitiesOfOp(engine, op);
      this.send(conn.ws, { type: 'op.reject', clientOpId, reason, ...entities });
    }
  }

  private async handleUndoRedo(conn: Conn, clientOpId: string, which: 'undo' | 'redo') {
    if (!conn.userId) return this.send(conn.ws, { type: 'op.reject', clientOpId, reason: '尚未加入画布' });
    const engine = await this.getEngine(conn.canvasId);
    try {
      const entry = await engine.enqueue(() =>
        which === 'undo' ? engine.undo(conn.userId) : engine.redo(conn.userId),
      );
      this.send(conn.ws, { type: 'op.ack', clientOpId, seq: entry.seq });
      this.broadcast(conn.canvasId, {
        type: 'op',
        seq: entry.seq,
        userId: entry.userId,
        kind: entry.kind,
        forward: entry.forward,
        label: entry.label,
      });
    } catch (err) {
      const reason = err instanceof OpError ? err.message : '操作被拒绝';
      this.send(conn.ws, { type: 'op.reject', clientOpId, reason });
    }
  }

  /** 拖动中的临时位置广播：不落库、不进日志；只读成员的一律忽略 */
  private async handlePreview(conn: Conn, shapes: Shape[]) {
    if (!conn.userId) return;
    const engine = await this.getEngine(conn.canvasId);
    const member = engine.getMember(conn.userId);
    if (!member || !canEdit(member.role)) return; // 只读预览静默丢弃，不广播脏位置
    const room = this.room(conn.canvasId);
    let ids = room.previews.get(conn.userId);
    if (!ids) {
      ids = new Set();
      room.previews.set(conn.userId, ids);
    }
    // 只广播服务端权威存在的图元，防止伪造 id
    const valid = shapes.filter((s) => engine.state.shapes.has(s.id));
    for (const s of valid) ids.add(s.id);
    if (valid.length > 0) this.broadcast(conn.canvasId, { type: 'preview', userId: conn.userId, shapes: valid }, conn);
  }

  private async clearPreview(conn: Conn, broadcastClear: boolean) {
    const room = this.rooms.get(conn.canvasId);
    const ids = room?.previews.get(conn.userId);
    if (!room || !ids || ids.size === 0) return;
    room.previews.delete(conn.userId);
    if (!broadcastClear) return;
    const engine = await this.getEngine(conn.canvasId);
    const authoritative = [...ids]
      .map((id) => engine.state.shapes.get(id))
      .filter((s): s is Shape => Boolean(s));
    this.broadcast(conn.canvasId, { type: 'preview.clear', userId: conn.userId, shapes: authoritative });
  }

  private async handlePreviewEnd(conn: Conn) {
    await this.clearPreview(conn, true);
  }

  private handlePresence(conn: Conn, msg: Extract<ClientMessage, { type: 'presence' }>) {
    if (!conn.userId) return;
    const room = this.room(conn.canvasId);
    const presence: PresenceState = { userId: conn.userId, cursor: msg.cursor, selection: msg.selection ?? [] };
    room.presence.set(conn.userId, presence);
    this.broadcast(conn.canvasId, { type: 'presence', presence }, conn);
  }

  private async handleRoleSet(conn: Conn, targetId: string, role: 'owner' | 'editor' | 'viewer') {
    if (!conn.userId) return;
    const engine = await this.getEngine(conn.canvasId);
    try {
      const member = await engine.enqueue(() => engine.setRole(conn.userId, targetId, role));
      this.broadcast(conn.canvasId, { type: 'role.changed', member });
      // 降级为只读：立即清除其进行中的预览，并用权威状态覆盖（进行中的拖动回滚）
      if (role === 'viewer') {
        const room = this.room(conn.canvasId);
        const ids = room.previews.get(targetId);
        if (ids && ids.size > 0) {
          room.previews.delete(targetId);
          const authoritative = [...ids]
            .map((id) => engine.state.shapes.get(id))
            .filter((s): s is Shape => Boolean(s));
          this.broadcast(conn.canvasId, { type: 'preview.clear', userId: targetId, shapes: authoritative });
        }
      }
    } catch (err) {
      const reason = err instanceof OpError ? err.message : '角色调整被拒绝';
      this.send(conn.ws, { type: 'error', reason });
    }
  }

  private async handleClose(conn: Conn) {
    if (!conn.canvasId) return;
    const room = this.rooms.get(conn.canvasId);
    if (!room) return;
    room.conns.delete(conn);
    if (conn.userId) {
      // 同一用户可能还有其它连接，都没有时才清除其 presence/preview
      const stillOnline = [...room.conns].some((c) => c.userId === conn.userId);
      if (!stillOnline) {
        room.presence.delete(conn.userId);
        this.broadcast(conn.canvasId, { type: 'presence.clear', userId: conn.userId });
        await this.clearPreview(conn, true);
      }
    }
  }
}
