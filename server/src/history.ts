/**
 * 历史存档点（checkpoint）的规范化表示与确定性重建。
 *
 * 存档点在打点那一刻把画布的完整权威状态（图元/连线/成员角色）凝固为一份
 * 规范化（canonical）快照：字段顺序固定、集合按 id 排序。因此同一个存档点
 * 无论何时、在哪个实例上重建，序列化结果都逐字节一致——这是"倒回历史"
 * 可校验、可重复的基础。
 *
 * 规范化快照随存档点元信息一起持久化（checkpoints 表），落定后不可变：
 * 之后画布继续演进、甚至发生多次恢复，都不影响已落定的存档点内容。
 */

import type { CanvasState, Connector, Member, Shape } from './types.js';

/** 存档点记录的完整画布状态（图元/连线/成员角色） */
export interface CheckpointState {
  shapes: Shape[];
  connectors: Connector[];
  members: Member[];
}

/* 以下 canonical* 函数逐一显式构造新对象：字段顺序固定，与来源对象的
 * 属性插入顺序无关，保证 JSON 序列化逐字节稳定。 */

export function canonicalShape(s: Shape): Shape {
  return { id: s.id, kind: s.kind, x: s.x, y: s.y, w: s.w, h: s.h, z: s.z, color: s.color, text: s.text };
}

export function canonicalConnector(c: Connector): Connector {
  return { id: c.id, from: c.from, to: c.to, fromSide: c.fromSide, toSide: c.toSide, path: [...c.path] };
}

export function canonicalMember(m: Member): Member {
  return { userId: m.userId, name: m.name, role: m.role, color: m.color };
}

const byId = <T extends { id: string }>(a: T, b: T) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const byUserId = (a: Member, b: Member) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0);

/** 把任意来源的状态整理为规范化快照（深拷贝 + 固定排序），可直接安全持有 */
export function canonicalCheckpointState(state: CheckpointState): CheckpointState {
  return {
    shapes: state.shapes.map(canonicalShape).sort(byId),
    connectors: state.connectors.map(canonicalConnector).sort(byId),
    members: state.members.map(canonicalMember).sort(byUserId),
  };
}

/** 从引擎当前权威状态提取规范化快照（打点那一刻调用） */
export function snapshotOf(state: CanvasState): CheckpointState {
  return canonicalCheckpointState({
    shapes: [...state.shapes.values()],
    connectors: [...state.connectors.values()],
    members: [...state.members.values()],
  });
}

/**
 * 规范化快照的确定性序列化：同一存档点在任意实例、任意时刻重建，
 * 得到的字符串逐字节一致。
 */
export function canonicalCheckpointString(state: CheckpointState): string {
  return JSON.stringify(canonicalCheckpointState(state));
}
