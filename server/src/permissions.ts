/**
 * 权限与角色判定。
 * 角色：owner（房主，可编辑且可调整他人角色）、editor（可编辑）、viewer（只读）。
 * 所有写路径（提交操作、撤销/重做、拖动预览）都必须经过这里的判定。
 */

import type { Member, Role } from './types.js';

export class OpError extends Error {
  /** 拒绝时附带相关实体的 id，便于回包携带权威状态让客户端回滚 */
  entityIds: { shapeIds?: string[]; connectorIds?: string[] };

  constructor(reason: string, entityIds: { shapeIds?: string[]; connectorIds?: string[] } = {}) {
    super(reason);
    this.name = 'OpError';
    this.entityIds = entityIds;
  }
}

export function canEdit(role: Role): boolean {
  return role === 'owner' || role === 'editor';
}

export function canManageRoles(role: Role): boolean {
  return role === 'owner';
}

/** 写操作（含 undo/redo）统一入口校验 */
export function assertCanEdit(member: Member | undefined, userId: string): asserts member is Member {
  if (!member) {
    throw new OpError(`用户 ${userId} 不是画布成员，写操作被拒绝`);
  }
  if (!canEdit(member.role)) {
    throw new OpError(`成员「${member.name}」当前为只读角色，写操作被拒绝（需要可编辑权限）`);
  }
}

export function assertCanManageRoles(member: Member | undefined, userId: string): asserts member is Member {
  if (!member) {
    throw new OpError(`用户 ${userId} 不是画布成员，无权调整角色`);
  }
  if (!canManageRoles(member.role)) {
    throw new OpError(`成员「${member.name}」不是房主，无权调整他人角色`);
  }
}

export function isValidRole(role: unknown): role is Role {
  return role === 'owner' || role === 'editor' || role === 'viewer';
}
