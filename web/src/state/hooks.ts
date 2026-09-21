import { useSyncExternalStore } from 'react';
import { WhiteboardStore } from './store';

/** 全局单例 store */
export const store = new WhiteboardStore();

/** 订阅 store 变化触发重渲染；组件直接读取 store 上的字段 */
export function useStore() {
  return useSyncExternalStore(store.subscribe, () => store.version);
}
