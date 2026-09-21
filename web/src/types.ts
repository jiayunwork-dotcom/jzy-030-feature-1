/**
 * 与后端 server/src/types.ts 同构的协议类型。
 */

export type Role = 'owner' | 'editor' | 'viewer';
export type ShapeKind = 'rect' | 'ellipse' | 'note';

export interface Shape {
  id: string;
  kind: ShapeKind;
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
  color: string;
  text: string;
}

export interface ShapeAttrs {
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  z?: number;
  color?: string;
  text?: string;
}

export type AnchorSide = 'n' | 'e' | 's' | 'w';

export interface Connector {
  id: string;
  from: string;
  to: string;
  fromSide: AnchorSide;
  toSide: AnchorSide;
  path: number[];
}

export interface Member {
  userId: string;
  name: string;
  role: Role;
  color: string;
}

export type Op =
  | { kind: 'shape.create'; shape: { id: string; kind: ShapeKind; x: number; y: number; w: number; h: number; color?: string; text?: string; z?: number } }
  | { kind: 'shape.set'; shapeId: string; attrs: ShapeAttrs }
  | { kind: 'shape.delete'; shapeId: string }
  | { kind: 'connector.create'; id: string; from: string; to: string }
  | { kind: 'connector.delete'; connectorId: string };

export interface ShapePatch {
  id: string;
  attrs: ShapeAttrs;
}

export interface Effects {
  upsertShapes?: Shape[];
  patchShapes?: ShapePatch[];
  deleteShapeIds?: string[];
  upsertConnectors?: Connector[];
  deleteConnectorIds?: string[];
}

export interface Snapshot {
  canvasId: string;
  seq: number;
  shapes: Shape[];
  connectors: Connector[];
  members: Member[];
}

export interface PresenceState {
  userId: string;
  cursor: { x: number; y: number } | null;
  selection: string[];
}

export type ClientMessage =
  | { type: 'hello'; canvasId: string; userId: string; name: string; lastSeq?: number }
  | { type: 'op'; clientOpId: string; op: Op }
  | { type: 'undo'; clientOpId: string }
  | { type: 'redo'; clientOpId: string }
  | { type: 'preview'; shapes: Shape[] }
  | { type: 'preview.end' }
  | { type: 'presence'; cursor: { x: number; y: number } | null; selection: string[] }
  | { type: 'role.set'; userId: string; role: Role };

export type ServerMessage =
  | { type: 'welcome'; canvasId: string; you: Member; seq: number; snapshot: Snapshot; deltas: { seq: number; userId: string; kind: string; forward: Effects }[]; presence: PresenceState[] }
  | { type: 'op'; seq: number; userId: string; kind: string; forward: Effects; label: string }
  | { type: 'op.ack'; clientOpId: string; seq: number }
  | { type: 'op.reject'; clientOpId: string; reason: string; shapes?: Shape[]; connectors?: Connector[] }
  | { type: 'preview'; userId: string; shapes: Shape[] }
  | { type: 'preview.clear'; userId: string; shapes: Shape[] }
  | { type: 'presence'; presence: PresenceState }
  | { type: 'presence.clear'; userId: string }
  | { type: 'role.changed'; member: Member }
  | { type: 'member.joined'; member: Member }
  | { type: 'error'; reason: string };
