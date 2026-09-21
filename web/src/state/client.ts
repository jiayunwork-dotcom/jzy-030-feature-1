/**
 * 协作客户端：管理 WebSocket 连接、自动重连（带 lastSeq 断点续传）、消息分发。
 * 状态本身由 WhiteboardStore 维护，这里只负责"线"。
 */

import type { ClientMessage, ServerMessage } from '../types';

export interface ClientEvents {
  onMessage(msg: ServerMessage): void;
  onConnectionChange(connected: boolean): void;
}

export class CollabClient {
  private ws: WebSocket | null = null;
  private reconnectTimer: number | null = null;
  private reconnectDelay = 500;
  private closedByUser = false;
  lastSeq = 0;

  constructor(
    private url: string,
    private hello: () => Extract<ClientMessage, { type: 'hello' }>,
    private events: ClientEvents,
  ) {}

  connect() {
    this.closedByUser = false;
    this.open();
  }

  private open() {
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.reconnectDelay = 500;
      // 重连时带上 lastSeq，服务端会回快照 + 断线期间的增量
      this.sendRaw({ ...this.hello(), lastSeq: this.lastSeq });
    };
    ws.onmessage = (ev) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg.type === 'welcome') {
        this.lastSeq = msg.seq;
        this.events.onConnectionChange(true);
      } else if (msg.type === 'op') {
        this.lastSeq = Math.max(this.lastSeq, msg.seq);
      }
      this.events.onMessage(msg);
    };
    ws.onclose = () => {
      this.events.onConnectionChange(false);
      if (!this.closedByUser) {
        this.reconnectTimer = window.setTimeout(() => this.open(), this.reconnectDelay);
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, 5000);
      }
    };
    ws.onerror = () => ws.close();
  }

  private sendRaw(msg: ClientMessage) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  send(msg: ClientMessage) {
    this.sendRaw(msg);
  }

  close() {
    this.closedByUser = true;
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }
}
