/**
 * 协作者光标层：实时渲染其他成员的光标位置与名字标签。
 */

import { store, useStore } from '../state/hooks';
import { CANVAS_H, CANVAS_W } from './CanvasView';

export function PresenceLayer() {
  useStore();
  return (
    <div className="presence-layer" style={{ aspectRatio: `${CANVAS_W} / ${CANVAS_H}` }}>
      {[...store.presence.values()].map((p) => {
        if (!p.cursor) return null;
        const member = store.members.get(p.userId);
        const color = member?.color ?? '#64748b';
        const name = member?.name ?? p.userId.slice(0, 4);
        return (
          <div
            key={p.userId}
            className="cursor"
            style={{ left: `${(p.cursor.x / CANVAS_W) * 100}%`, top: `${(p.cursor.y / CANVAS_H) * 100}%` }}
          >
            <svg width="14" height="18" viewBox="0 0 14 18">
              <path d="M1 1 L13 8 L7.5 9.5 L5.5 15 Z" fill={color} stroke="#fff" strokeWidth="1" />
            </svg>
            <span className="cursor-name" style={{ background: color }}>
              {name}
            </span>
          </div>
        );
      })}
    </div>
  );
}
