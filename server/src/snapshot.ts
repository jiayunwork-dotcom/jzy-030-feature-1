/**
 * 快照与增量：
 * - snapshot() 输出当前完整画布状态（图元/连线/成员 + 当前 seq）。
 * - deltasSince(seq) 输出断线期间错过的增量（按 seq 升序），
 *   重连客户端先拿快照对齐权威状态，再凭增量确认连续性，
 *   不依赖本地缓存拼凑画面。
 */

import type { Engine } from './engine.js';
import type { Effects, LogEntry, Snapshot } from './types.js';

export function buildSnapshot(engine: Engine): Snapshot {
  const s = engine.state;
  return {
    canvasId: s.id,
    seq: s.seq,
    shapes: [...s.shapes.values()].sort((a, b) => a.z - b.z),
    connectors: [...s.connectors.values()],
    members: [...s.members.values()],
  };
}

export interface Delta {
  seq: number;
  userId: string;
  kind: LogEntry['kind'];
  forward: Effects;
  label: string;
}

export function deltasSince(engine: Engine, lastSeq: number): Delta[] {
  return engine
    .deltasSince(lastSeq)
    .sort((a, b) => a.seq - b.seq)
    .map((e) => ({ seq: e.seq, userId: e.userId, kind: e.kind, forward: e.forward, label: e.label }));
}
