/**
 * 时间线面板：画布的存档点入口（独立于工具栏与成员面板）。
 * - 所有在线成员都能看到存档点列表（名字/创建者/创建时刻/对应序列位置）。
 * - "打点"与"恢复到此"是房主专属：非房主看到的是禁用态，
 *   即便绕过前端直接发消息，服务端也会拒绝并返回可读原因。
 * - 恢复成功后所有人的画面随服务端 restored 广播整体对齐。
 */

import { useState } from 'react';
import { store, useStore } from '../state/hooks';
import type { CheckpointMeta } from '../types';

function formatTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function TimelinePanel() {
  useStore();
  const [name, setName] = useState('');
  const isOwner = store.isOwner;
  if (!store.timelineOpen) return null;

  // 时间线：新的在前
  const checkpoints = [...store.checkpoints].sort(
    (a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1),
  );

  const submit = () => {
    store.createCheckpoint(name);
    setName('');
  };

  const restore = (cp: CheckpointMeta) => {
    if (!isOwner) return;
    const ok = window.confirm(
      `确定要把整张画布恢复到存档点「${cp.name}」吗？\n` +
        '所有在线成员的画面都会切换到该存档点当时的样子，进行中的编辑会被打断。\n' +
        '（历史不会被删除，之后仍可以恢复到其它存档点）',
    );
    if (ok) store.restoreCheckpoint(cp.id);
  };

  return (
    <div className="timeline">
      <div className="timeline-title">时间线 · 存档点</div>

      <div className="checkpoint-create">
        <input
          value={name}
          placeholder={isOwner ? '存档点名字，如：评审前版本' : '仅房主可以打存档点'}
          disabled={!isOwner}
          maxLength={80}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && isOwner) submit();
          }}
        />
        <button
          onClick={submit}
          disabled={!isOwner || !name.trim()}
          title={isOwner ? '把当前画布状态存为一个不可变的存档点' : '仅房主可以打存档点'}
        >
          打点
        </button>
      </div>

      {checkpoints.length === 0 && (
        <div className="checkpoint-empty">
          还没有存档点。{isOwner ? '给当前画布打一个，之后随时可以倒回来。' : '房主打点后会出现在这里。'}
        </div>
      )}

      {checkpoints.map((cp) => (
        <div key={cp.id} className="checkpoint-row">
          <div className="checkpoint-dot" />
          <div className="checkpoint-body">
            <div className="checkpoint-name" title={cp.id}>
              {cp.name}
            </div>
            <div className="checkpoint-meta">
              {cp.createdByName} · {formatTime(cp.createdAt)} · 序列 #{cp.seq}
            </div>
          </div>
          <button
            className="checkpoint-restore"
            onClick={() => restore(cp)}
            disabled={!isOwner}
            title={isOwner ? `把整张画布恢复到「${cp.name}」` : '仅房主可以恢复'}
          >
            恢复到此
          </button>
        </div>
      ))}
    </div>
  );
}
