/**
 * 连线路由模块：
 * - 端点贴合到图元边界上"离对端最近"的锚点（四边中点）。
 * - 路径为正交折线，先沿锚点外法线离开图元本体，再汇合到对端，
 *   因此不会穿过两个被连接图元的内部。
 * - 纯函数：同样输入永远得到同样输出；锚点距离相同时按固定优先级
 *   打破平局，两个图元靠近或重叠时走向依然确定、可复现。
 */

import type { AnchorSide, Shape } from './types.js';

export interface ShapeBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface RouteResult {
  fromSide: AnchorSide;
  toSide: AnchorSide;
  path: number[];
}

/** 锚点外扩距离：路径先垂直走出图元这么远再拐弯，避免穿过本体 */
const MARGIN = 24;

/** 固定平局优先级，保证确定性 */
const SIDE_ORDER: AnchorSide[] = ['n', 'e', 's', 'w'];

const NORMALS: Record<AnchorSide, { dx: number; dy: number }> = {
  n: { dx: 0, dy: -1 },
  e: { dx: 1, dy: 0 },
  s: { dx: 0, dy: 1 },
  w: { dx: -1, dy: 0 },
};

interface Pt {
  x: number;
  y: number;
}

function center(b: ShapeBox): Pt {
  return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
}

/** 某侧锚点（边中点）坐标 */
export function anchorPoint(b: ShapeBox, side: AnchorSide): Pt {
  const c = center(b);
  switch (side) {
    case 'n':
      return { x: c.x, y: b.y };
    case 's':
      return { x: c.x, y: b.y + b.h };
    case 'e':
      return { x: b.x + b.w, y: c.y };
    case 'w':
      return { x: b.x, y: c.y };
  }
}

const isHorizontal = (s: AnchorSide) => s === 'e' || s === 'w';

function dist2(a: Pt, b: Pt): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

/**
 * 选择两侧锚点：遍历 4x4 组合，取锚点间距离最小者；
 * 距离相同按 (fromSide, toSide) 在 SIDE_ORDER 中的序号字典序取前者，
 * 因此重叠/同心等退化情形也有唯一确定结果。
 */
export function chooseAnchors(a: ShapeBox, b: ShapeBox): { fromSide: AnchorSide; toSide: AnchorSide } {
  let best: { fromSide: AnchorSide; toSide: AnchorSide } | null = null;
  let bestKey: [number, number, number] | null = null;
  for (const fromSide of SIDE_ORDER) {
    const pa = anchorPoint(a, fromSide);
    for (const toSide of SIDE_ORDER) {
      const pb = anchorPoint(b, toSide);
      const key: [number, number, number] = [
        dist2(pa, pb),
        SIDE_ORDER.indexOf(fromSide),
        SIDE_ORDER.indexOf(toSide),
      ];
      if (
        bestKey === null ||
        key[0] < bestKey[0] ||
        (key[0] === bestKey[0] && (key[1] < bestKey[1] || (key[1] === bestKey[1] && key[2] < bestKey[2])))
      ) {
        bestKey = key;
        best = { fromSide, toSide };
      }
    }
  }
  return best!;
}

/** 保留两位小数，消除浮点噪声，保证跨次计算逐位一致 */
const r2 = (n: number) => Math.round(n * 100) / 100;

function push(pts: Pt[], p: Pt) {
  const last = pts[pts.length - 1];
  if (!last || last.x !== p.x || last.y !== p.y) pts.push(p);
}

/**
 * 计算 a -> b 的连线路由。
 * 路径从 a 的锚点沿外法线走出 MARGIN，正交汇合到 b 锚点外 MARGIN 处，
 * 再垂直进入 b 的锚点。
 */
export function routeConnector(a: ShapeBox, b: ShapeBox): RouteResult {
  const { fromSide, toSide } = chooseAnchors(a, b);
  const p0 = anchorPoint(a, fromSide);
  const p5 = anchorPoint(b, toSide);
  const nA = NORMALS[fromSide];
  const nB = NORMALS[toSide];
  const p1: Pt = { x: r2(p0.x + nA.dx * MARGIN), y: r2(p0.y + nA.dy * MARGIN) };
  const p4: Pt = { x: r2(p5.x + nB.dx * MARGIN), y: r2(p5.y + nB.dy * MARGIN) };

  const pts: Pt[] = [];
  push(pts, p0);
  push(pts, p1);

  const aH = isHorizontal(fromSide);
  const bH = isHorizontal(toSide);
  if (aH && bH) {
    // 两个水平锚点：横-纵-横，中间竖段取两者中点 x
    const midX = r2((p1.x + p4.x) / 2);
    push(pts, { x: midX, y: p1.y });
    push(pts, { x: midX, y: p4.y });
  } else if (!aH && !bH) {
    // 两个垂直锚点：纵-横-纵
    const midY = r2((p1.y + p4.y) / 2);
    push(pts, { x: p1.x, y: midY });
    push(pts, { x: p4.x, y: midY });
  } else if (aH) {
    // a 水平出发（先横），b 垂直进入（先纵）：拐角取 (p4.x, p1.y)
    push(pts, { x: p4.x, y: p1.y });
  } else {
    // a 垂直出发（先纵），b 水平进入（先横）：拐角取 (p1.x, p4.y)
    push(pts, { x: p1.x, y: p4.y });
  }

  push(pts, p4);
  push(pts, p5);

  const path: number[] = [];
  for (const p of pts) path.push(r2(p.x), r2(p.y));
  return { fromSide, toSide, path };
}

/** 便于测试与调试：路径是否完全在两个图元各自的内部之外（端点除外） */
export function pathAvoidsBoxes(path: number[], boxes: ShapeBox[]): boolean {
  const inside = (p: Pt, b: ShapeBox) => p.x > b.x && p.x < b.x + b.w && p.y > b.y && p.y < b.y + b.h;
  for (let i = 1; i < path.length / 2 - 1; i++) {
    const p = { x: path[i * 2], y: path[i * 2 + 1] };
    for (const b of boxes) if (inside(p, b)) return false;
  }
  return true;
}

export type { Shape };
