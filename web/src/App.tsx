import { useEffect } from 'react';
import { CanvasView } from './components/CanvasView';
import { MembersPanel } from './components/MembersPanel';
import { Toolbar } from './components/Toolbar';
import { store, useStore } from './state/hooks';

export default function App() {
  useStore();

  useEffect(() => {
    store.connect();
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) {
        e.preventDefault();
        store.undo();
      } else if ((mod && e.key.toLowerCase() === 'z' && e.shiftKey) || (mod && e.key.toLowerCase() === 'y')) {
        e.preventDefault();
        store.redo();
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && store.selection.length > 0) {
        const target = e.target as HTMLElement;
        if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;
        store.deleteSelection();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="app">
      <Toolbar />
      <div className="main">
        <CanvasView />
        <MembersPanel />
      </div>
      {store.self?.role === 'viewer' && (
        <div className="readonly-banner">你当前是只读角色：可以观看与移动光标，编辑操作将被拒绝</div>
      )}
      <div className="toasts">
        {store.toasts.map((t) => (
          <div key={t.id} className="toast">
            {t.text}
          </div>
        ))}
      </div>
    </div>
  );
}
