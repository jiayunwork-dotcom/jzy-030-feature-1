/**
 * 工具栏：选择/图形/便签/连线工具、颜色、删除、撤销重做、连接状态与角色标识。
 */

import { store, useStore } from '../state/hooks';
import type { Tool } from '../state/store';

const TOOLS: { id: Tool; label: string }[] = [
  { id: 'select', label: '选择' },
  { id: 'rect', label: '矩形' },
  { id: 'ellipse', label: '椭圆' },
  { id: 'note', label: '便签' },
  { id: 'connect', label: '连线' },
];

export function Toolbar() {
  useStore();
  const roleLabel = store.self?.role === 'owner' ? '房主' : store.self?.role === 'editor' ? '可编辑' : '只读';
  return (
    <div className="toolbar">
      <span className="brand">协作白板</span>
      {TOOLS.map((t) => (
        <button
          key={t.id}
          className={store.tool === t.id ? 'active' : ''}
          onClick={() => store.setTool(t.id)}
          disabled={!store.canEdit && t.id !== 'select'}
          title={!store.canEdit && t.id !== 'select' ? '只读角色不可用' : ''}
        >
          {t.label}
        </button>
      ))}
      <input
        type="color"
        defaultValue="#93c5fd"
        onChange={(e) => store.setColorForSelection(e.target.value)}
        disabled={!store.canEdit || store.selection.length === 0}
        title="修改选中图元颜色"
      />
      <button onClick={() => store.deleteSelection()} disabled={!store.canEdit || store.selection.length === 0}>
        删除
      </button>
      <span className="sep" />
      <button onClick={() => store.undo()} disabled={!store.canEdit}>
        撤销
      </button>
      <button onClick={() => store.redo()} disabled={!store.canEdit}>
        重做
      </button>
      <span className="sep" />
      <span className={`badge role-${store.self?.role ?? 'viewer'}`}>{roleLabel}</span>
      <span className={`badge ${store.connected ? 'online' : 'offline'}`}>
        {store.connected ? '已连接' : '重连中…'}
      </span>
    </div>
  );
}
