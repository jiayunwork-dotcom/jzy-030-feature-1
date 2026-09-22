/**
 * 历史维度的纯函数模块：
 * - canonicalState：从当前权威状态抽取"存档内容"，并按稳定键排序。
 * - canonicalJson / canonicalDigest：规范化序列化，同一存档点在任何时刻、
 *   任何实例上重建得到逐字节一致的结果（JSON 键序固定、数组排序固定，
 *   不含 id 之外的随机/时钟成分；id 为创建时落定的稳定标识）。
 * - diffStates：计算两个完整状态之间的 Effects 差异（图元/连线/成员），
 *   恢复即"当前态 -> 存档点态"的一次性整体差异。
 */

import { createHash } from 'node:crypto';
import type {
  CanonicalState,
  Connector,
  Effects,
  Member,
  Shape,
} from './types.js';

export function canonicalState(
  shapes: Iterable<Shape>,
  connectors: Iterable<Connector>,
  members: Iterable<Member>,
): CanonicalState {
  return {
    shapes: [...shapes].map((s) => structuredClone(s)).sort((a, b) => a.id.localeCompare(b.id)),
    connectors: [...connectors].map((c) => structuredClone(c)).sort((a, b) => a.id.localeCompare(b.id)),
    members: [...members].map((m) => structuredClone(m)).sort((a, b) => a.userId.localeCompare(b.userId)),
  };
}

/** 规范化序列化：键按固定白名单顺序输出，数组须已排序 */
export function canonicalJson(state: CanonicalState): string {
  const shape = (s: Shape) =>
    `{"id":${JSON.stringify(s.id)},"kind":${JSON.stringify(s.kind)},"x":${s.x},"y":${s.y},"w":${s.w},"h":${s.h},"z":${s.z},"color":${JSON.stringify(s.color)},"text":${JSON.stringify(s.text)}}`;
  const connector = (c: Connector) =>
    `{"id":${JSON.stringify(c.id)},"from":${JSON.stringify(c.from)},"to":${JSON.stringify(c.to)},"fromSide":${JSON.stringify(c.fromSide)},"toSide":${JSON.stringify(c.toSide)},"path":[${c.path.join(',')}]}`;
  const member = (m: Member) =>
    `{"userId":${JSON.stringify(m.userId)},"name":${JSON.stringify(m.name)},"role":${JSON.stringify(m.role)},"color":${JSON.stringify(m.color)}}`;
  return (
    `{"shapes":[${state.shapes.map(shape).join(',')}],` +
    `"connectors":[${state.connectors.map(connector).join(',')}],` +
    `"members":[${state.members.map(member).join(',')}]}`
  );
}

/** 规范化内容的指纹（hex），用于测试与校验"多次重建逐字节一致" */
export function canonicalDigest(state: CanonicalState): string {
  return createHash('sha256').update(canonicalJson(state)).digest('hex');
}

/**
 * 计算 from -> to 的整体差异。恢复时 from=当前权威态、to=存档点态。
 * - 图元：相同 id 且内容不同 -> upsert（整条权威值覆盖，不用 patch，
 *   保证客户端无需知道中间历史就能对齐）；缺失 -> 删除；新增 -> upsert。
 * - 连线/成员同理。成员的增删在恢复中不会发生（成员集合持久且不随存档删除），
 *   仅角色等字段可能变化 -> upsertMembers。
 */
export function diffStates(from: CanonicalState, to: CanonicalState): Effects {
  const fx: Effects = {};
  const toShapes = new Map(to.shapes.map((s) => [s.id, s]));
  const fromShapes = new Map(from.shapes.map((s) => [s.id, s]));
  for (const s of to.shapes) {
    const prev = fromShapes.get(s.id);
    if (!prev || JSON.stringify(prev) !== JSON.stringify(s)) {
      (fx.upsertShapes ??= []).push(structuredClone(s));
    }
  }
  for (const id of fromShapes.keys()) {
    if (!toShapes.has(id)) (fx.deleteShapeIds ??= []).push(id);
  }

  const toConns = new Map(to.connectors.map((c) => [c.id, c]));
  const fromConns = new Map(from.connectors.map((c) => [c.id, c]));
  for (const c of to.connectors) {
    const prev = fromConns.get(c.id);
    if (!prev || JSON.stringify(prev) !== JSON.stringify(c)) {
      (fx.upsertConnectors ??= []).push(structuredClone(c));
    }
  }
  for (const id of fromConns.keys()) {
    if (!toConns.has(id)) (fx.deleteConnectorIds ??= []).push(id);
  }

  const toMembers = new Map(to.members.map((m) => [m.userId, m]));
  for (const m of to.members) {
    const prev = [...from.members].find((x) => x.userId === m.userId);
    if (!prev || JSON.stringify(prev) !== JSON.stringify(m)) {
      (fx.upsertMembers ??= []).push(structuredClone(m));
    }
  }
  for (const m of from.members) {
    if (!toMembers.has(m.userId)) (fx.deleteMemberIds ??= []).push(m.userId);
  }

  // 稳定输出顺序，保证广播/日志内容确定
  fx.deleteShapeIds?.sort();
  fx.deleteConnectorIds?.sort();
  fx.deleteMemberIds?.sort();
  return fx;
}

/** 应用一组整体差异到可变状态（服务端恢复时用；连线不重算——存档内容即权威） */
export function applyStateEffects(
  state: { shapes: Map<string, Shape>; connectors: Map<string, Connector>; members: Map<string, Member> },
  fx: Effects,
): void {
  for (const s of fx.upsertShapes ?? []) state.shapes.set(s.id, structuredClone(s));
  for (const id of fx.deleteShapeIds ?? []) state.shapes.delete(id);
  for (const c of fx.upsertConnectors ?? []) state.connectors.set(c.id, structuredClone(c));
  for (const id of fx.deleteConnectorIds ?? []) state.connectors.delete(id);
  for (const m of fx.upsertMembers ?? []) state.members.set(m.userId, structuredClone(m));
  for (const id of fx.deleteMemberIds ?? []) state.members.delete(id);
}
