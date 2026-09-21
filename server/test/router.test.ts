import { describe, expect, it } from 'vitest';
import { anchorPoint, chooseAnchors, pathAvoidsBoxes, routeConnector } from '../src/router.js';

const box = (x: number, y: number, w = 100, h = 100) => ({ x, y, w, h });

describe('连线路由', () => {
  it('并排的图元：端点贴合到相对的边中点（最近锚点）', () => {
    const a = box(0, 0);
    const b = box(300, 0); // b 在 a 右侧
    const r = routeConnector(a, b);
    expect(r.fromSide).toBe('e');
    expect(r.toSide).toBe('w');
    // 端点精确落在边界锚点上
    expect(r.path[0]).toBe(100); // a 右边中点 x
    expect(r.path[1]).toBe(50);
    expect(r.path[r.path.length - 2]).toBe(300); // b 左边中点 x
    expect(r.path[r.path.length - 1]).toBe(50);
  });

  it('上下排列的图元：使用底边/顶边锚点', () => {
    const r = routeConnector(box(0, 0), box(0, 300));
    expect(r.fromSide).toBe('s');
    expect(r.toSide).toBe('n');
  });

  it('路径可复现：同样输入多次计算逐位一致', () => {
    const a = box(10, 20, 130, 77);
    const b = box(321, 234, 90, 140);
    const r1 = routeConnector(a, b);
    const r2 = routeConnector(a, b);
    expect(r1).toEqual(r2);
    expect(r1.path.join(',')).toBe(r2.path.join(','));
  });

  it('图元重叠/同心时走向依然确定', () => {
    const a = box(100, 100);
    const b = box(120, 110); // 大面积重叠
    const r1 = routeConnector(a, b);
    const r2 = routeConnector(a, b);
    expect(r1).toEqual(r2);
    const c1 = chooseAnchors(a, b);
    const c2 = chooseAnchors(a, b);
    expect(c1).toEqual(c2);
    // 完全同心也有确定结果
    const same1 = routeConnector(box(0, 0), box(0, 0));
    const same2 = routeConnector(box(0, 0), box(0, 0));
    expect(same1).toEqual(same2);
  });

  it('路径不穿过两个被连接图元的内部', () => {
    const cases: [ReturnType<typeof box>, ReturnType<typeof box>][] = [
      [box(0, 0), box(400, 0)],
      [box(0, 0), box(0, 400)],
      [box(0, 0), box(400, 400)],
      [box(400, 0), box(0, 300)],
      [box(50, 50, 200, 120), box(10, 300, 150, 90)],
    ];
    for (const [a, b] of cases) {
      const r = routeConnector(a, b);
      expect(pathAvoidsBoxes(r.path, [a, b])).toBe(true);
    }
  });

  it('anchorPoint 返回各边中点', () => {
    const b = box(10, 20, 100, 60);
    expect(anchorPoint(b, 'n')).toEqual({ x: 60, y: 20 });
    expect(anchorPoint(b, 's')).toEqual({ x: 60, y: 80 });
    expect(anchorPoint(b, 'e')).toEqual({ x: 110, y: 50 });
    expect(anchorPoint(b, 'w')).toEqual({ x: 10, y: 50 });
  });
});
