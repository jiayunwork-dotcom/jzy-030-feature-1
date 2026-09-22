/**
 * 时间线面板：历史存档点列表 + 打点 / 恢复到此。
 * - 列表对所有在线成员可见：名字、创建者、创建时刻、对应的序列位置（seq/纪元）。
 * - 打点与恢复是房主专属：非房主两个动作按钮禁用并说明原因
 *   （绕过 UI 发起时服务端仍会明确拒绝）。
 * - 恢复成功后画面由服务端 restore 广播整体刷新，本面板只负责发请求。
 */

import { useState } from 'react';
import { store, useStore } from '../state/hooks';

function formatTime(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function TimelinePanel() {
  useStore();
  const [name, setName] = useState('');
  const isOwner = store.self?.role === 'owner';
  const checkpoints = [...store.checkpoints].sort((a, b) => b.at - a.at || b.seq - a.seq);

  const submit = () => {
    const value = name.trim();
    if (!value) return;
    store.createCheckpoint(value);
    setName('');
  };

  return (
    <div className="timeline">
      <div className="timeline-title">时间线 · 存档点（{store.checkpoints.length}）</div>

      <div className="timeline-create">
        <input
          className="timeline-input"
          value={name}
          maxLength={80}
          placeholder={isOwner ? '存档点名字，如：评审前版本' : '仅房主可创建存档点'}
          disabled={!isOwner}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
          }}
        />
        <button className="timeline-btn" onClick={submit} disabled={!isOwner || !name.trim()} title={!isOwner ? '仅房主可以创建存档点' : '把当前画布状态存为不可变存档点'}>
          打点
        </button>
      </div>

      <div className="timeline-list">
        {checkpoints.length === 0 && <div className="timeline-empty">还没有存档点</div>}
        {checkpoints.map((cp) => (
          <div key={cp.id} className="checkpoint-row" title={`稳定标识：${cp.id}`}>
            <div className="checkpoint-name">{cp.name}</div>
            <div className="checkpoint-meta">
              {cp.creatorName} · {formatTime(cp.at)}
            </div>
            <div className="checkpoint-seq">
              序列 #{cp.seq} · 纪元 {cp.epoch}
            </div>
            <button
              className="restore-btn"
              disabled={!isOwner}
              title={!isOwner ? '仅房主可以把画布恢复到该存档点' : '把整块画布整体倒回到该存档点'}
              onClick={() => {
                if (window.confirm(`确定把画布整体恢复到存档点「${cp.name}」？\n恢复不会删除历史，之后仍可继续编辑并回到任意存档点。`)) {
                  store.restoreCheckpoint(cp.id);
                }
              }}
            >
              恢复到此
            </button>
          </div>
        ))}
      </div>
      {!isOwner && <div className="timeline-hint">只读/可编辑成员仅可查看时间线，打点与恢复为房主专属</div>}
    </div>
  );
}
