/**
 * 画布组件：SVG 渲染图元/连线/便签，处理选择、拖动、缩放、画新图元、连线交互。
 * 渲染优先级：权威状态 < 他人拖动预览（虚线标示临时态）。
 */

import { useRef, useState } from 'react';
import type { Shape } from '../types';
import { store, useStore } from '../state/hooks';
import { PresenceLayer } from './PresenceLayer';

export const CANVAS_W = 1600;
export const CANVAS_H = 1000;

interface Marquee {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export function CanvasView() {
  useStore();
  const svgRef = useRef<SVGSVGElement>(null);
  const [marquee, setMarquee] = useState<Marquee | null>(null);

  const toCanvas = (e: React.PointerEvent): { x: number; y: number } => {
    const rect = svgRef.current!.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * CANVAS_W,
      y: ((e.clientY - rect.top) / rect.height) * CANVAS_H,
    };
  };

  // 应用他人预览得到展示态
  const display = new Map<string, Shape>();
  for (const [id, s] of store.shapes) display.set(id, s);
  const previewedBy = new Map<string, string>();
  for (const [userId, shapes] of store.previews) {
    for (const s of shapes) {
      display.set(s.id, s);
      previewedBy.set(s.id, userId);
    }
  }
  const sorted = [...display.values()].sort((a, b) => a.z - b.z);

  const onPointerDown = (e: React.PointerEvent) => {
    const p = toCanvas(e);
    if (e.target === svgRef.current || (e.target as Element).tagName === 'rect' && (e.target as Element).id === 'bg') {
      if (store.tool === 'select') {
        store.select([]);
      } else if (store.tool === 'rect' || store.tool === 'ellipse' || store.tool === 'note') {
        if (!store.canEdit) return store.toast('当前为只读角色，无法创建图元');
        setMarquee({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
      }
    }
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const p = toCanvas(e);
    store.sendCursor(p.x, p.y);
    if (marquee) {
      setMarquee({ ...marquee, x1: p.x, y1: p.y });
    } else if (store.isDragging()) {
      store.updateDrag(p.x, p.y);
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const p = toCanvas(e);
    if (marquee) {
      const x = Math.min(marquee.x0, p.x);
      const y = Math.min(marquee.y0, p.y);
      const w = Math.abs(p.x - marquee.x0);
      const h = Math.abs(p.y - marquee.y0);
      setMarquee(null);
      if (w >= 20 && h >= 20 && (store.tool === 'rect' || store.tool === 'ellipse' || store.tool === 'note')) {
        store.createShape(store.tool, x, y, w, h);
      }
      return;
    }
    store.endDrag();
  };

  const onShapePointerDown = (e: React.PointerEvent, id: string) => {
    e.stopPropagation();
    if (store.tool === 'connect') {
      store.clickConnect(id);
      return;
    }
    if (!store.selection.includes(id)) store.select([id]);
    const p = toCanvas(e);
    store.beginDrag(id, 'move', p.x, p.y);
    (e.currentTarget.closest('svg') as Element)?.setPointerCapture?.(e.pointerId);
  };

  const onResizePointerDown = (e: React.PointerEvent, id: string) => {
    e.stopPropagation();
    const p = toCanvas(e);
    store.beginDrag(id, 'resize', p.x, p.y);
    (e.currentTarget.closest('svg') as Element)?.setPointerCapture?.(e.pointerId);
  };

  const selectedShape = store.selection.length === 1 ? display.get(store.selection[0]) : undefined;

  return (
    <div className="canvas-wrap">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${CANVAS_W} ${CANVAS_H}`}
        className="canvas"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => store.endDrag()}
      >
        <defs>
          <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 1 L 9 5 L 0 9 z" fill="#64748b" />
          </marker>
        </defs>
        <rect id="bg" x="0" y="0" width={CANVAS_W} height={CANVAS_H} fill="#f8fafc" />

        {/* 连线 */}
        {[...store.connectors.values()].map((c) => {
          const pts: string[] = [];
          for (let i = 0; i < c.path.length; i += 2) pts.push(`${c.path[i]},${c.path[i + 1]}`);
          return (
            <polyline
              key={c.id}
              points={pts.join(' ')}
              fill="none"
              stroke="#64748b"
              strokeWidth={2}
              markerEnd="url(#arrow)"
            />
          );
        })}

        {/* 图元 */}
        {sorted.map((s) => (
          <ShapeView
            key={s.id}
            shape={s}
            selected={store.selection.includes(s.id)}
            previewed={previewedBy.has(s.id)}
            connectSource={store.connectSource === s.id}
            onPointerDown={onShapePointerDown}
            onDoubleClick={() => store.editText(s.id)}
          />
        ))}

        {/* 他人选中框 */}
        {[...store.presence.values()].flatMap((p) => {
          const member = store.members.get(p.userId);
          const color = member?.color ?? '#999';
          return p.selection
            .map((id) => display.get(id))
            .filter((s): s is Shape => Boolean(s))
            .map((s) => (
              <rect
                key={`${p.userId}-${s.id}`}
                x={s.x - 5}
                y={s.y - 5}
                width={s.w + 10}
                height={s.h + 10}
                fill="none"
                stroke={color}
                strokeWidth={1.5}
                strokeDasharray="6 4"
                pointerEvents="none"
              />
            ));
        })}

        {/* 本人选中框 + 缩放手柄 */}
        {selectedShape && (
          <g pointerEvents="none">
            <rect
              x={selectedShape.x - 4}
              y={selectedShape.y - 4}
              width={selectedShape.w + 8}
              height={selectedShape.h + 8}
              fill="none"
              stroke="#2563eb"
              strokeWidth={1.5}
            />
          </g>
        )}
        {selectedShape && store.canEdit && (
          <rect
            x={selectedShape.x + selectedShape.w - 5}
            y={selectedShape.y + selectedShape.h - 5}
            width={10}
            height={10}
            fill="#2563eb"
            cursor="nwse-resize"
            onPointerDown={(e) => onResizePointerDown(e, selectedShape.id)}
          />
        )}

        {/* 新建图元的框选预览 */}
        {marquee && (
          <rect
            x={Math.min(marquee.x0, marquee.x1)}
            y={Math.min(marquee.y0, marquee.y1)}
            width={Math.abs(marquee.x1 - marquee.x0)}
            height={Math.abs(marquee.y1 - marquee.y0)}
            fill="rgba(37,99,235,0.08)"
            stroke="#2563eb"
            strokeDasharray="4 3"
          />
        )}
      </svg>
      <PresenceLayer />
    </div>
  );
}

function ShapeView(props: {
  shape: Shape;
  selected: boolean;
  previewed: boolean;
  connectSource: boolean;
  onPointerDown: (e: React.PointerEvent, id: string) => void;
  onDoubleClick: () => void;
}) {
  const { shape: s } = props;
  const common = {
    fill: s.color,
    stroke: props.connectSource ? '#f59e0b' : props.previewed ? '#94a3b8' : '#334155',
    strokeWidth: props.connectSource ? 3 : 1.5,
    strokeDasharray: props.previewed ? '5 4' : undefined,
    cursor: 'move',
    onPointerDown: (e: React.PointerEvent) => props.onPointerDown(e, s.id),
    onDoubleClick: props.onDoubleClick,
  };
  const textLines = s.text ? s.text.split('\n').slice(0, 5) : [];
  return (
    <g opacity={props.previewed ? 0.75 : 1}>
      {s.kind === 'rect' && <rect x={s.x} y={s.y} width={s.w} height={s.h} rx={6} {...common} />}
      {s.kind === 'ellipse' && (
        <ellipse cx={s.x + s.w / 2} cy={s.y + s.h / 2} rx={s.w / 2} ry={s.h / 2} {...common} />
      )}
      {s.kind === 'note' && (
        <g>
          <rect x={s.x} y={s.y} width={s.w} height={s.h} rx={3} {...common} />
          <path
            d={`M ${s.x + s.w - 16} ${s.y} L ${s.x + s.w} ${s.y + 16} L ${s.x + s.w - 16} ${s.y + 16} Z`}
            fill="rgba(0,0,0,0.12)"
            pointerEvents="none"
          />
        </g>
      )}
      {textLines.map((line, i) => (
        <text
          key={i}
          x={s.x + s.w / 2}
          y={s.y + 20 + i * 16}
          textAnchor="middle"
          fontSize={13}
          fill="#1e293b"
          pointerEvents="none"
        >
          {line.slice(0, 24)}
        </text>
      ))}
    </g>
  );
}
