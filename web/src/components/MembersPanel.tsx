/**
 * 成员面板：在线成员及其角色；房主可随时把成员在 可编辑/只读 间切换。
 */

import { store, useStore } from '../state/hooks';

export function MembersPanel() {
  useStore();
  const isOwner = store.self?.role === 'owner';
  return (
    <div className="members">
      <div className="members-title">成员（{store.members.size}）</div>
      {[...store.members.values()].map((m) => (
        <div key={m.userId} className="member-row">
          <span className="dot" style={{ background: m.color }} />
          <span className="member-name">
            {m.name}
            {m.userId === store.self?.userId ? '（我）' : ''}
          </span>
          <span className={`badge role-${m.role}`}>
            {m.role === 'owner' ? '房主' : m.role === 'editor' ? '可编辑' : '只读'}
          </span>
          {isOwner && m.userId !== store.self?.userId && (
            <button
              className="role-toggle"
              onClick={() => store.setRole(m.userId, m.role === 'viewer' ? 'editor' : 'viewer')}
              title="切换该成员角色"
            >
              {m.role === 'viewer' ? '设为可编辑' : '设为只读'}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
