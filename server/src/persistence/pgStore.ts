/**
 * PostgreSQL 16 持久化实现。
 * 表结构：canvases / members / shapes / connectors / op_log。
 * 服务器重启后从 op_log 重建定序与撤销栈，从 shapes/connectors 恢复画布内容。
 */

import pg from 'pg';
import type { Connector, LogEntry, Member, Shape } from '../types.js';
import type { PersistedCanvas, Store } from './store.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS canvases (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS members (
  canvas_id TEXT NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  color TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (canvas_id, user_id)
);
CREATE TABLE IF NOT EXISTS shapes (
  id TEXT NOT NULL,
  canvas_id TEXT NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  x DOUBLE PRECISION NOT NULL,
  y DOUBLE PRECISION NOT NULL,
  w DOUBLE PRECISION NOT NULL,
  h DOUBLE PRECISION NOT NULL,
  z INTEGER NOT NULL,
  color TEXT NOT NULL,
  text TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (canvas_id, id)
);
CREATE TABLE IF NOT EXISTS connectors (
  id TEXT NOT NULL,
  canvas_id TEXT NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  from_side TEXT NOT NULL,
  to_side TEXT NOT NULL,
  path JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (canvas_id, id)
);
CREATE TABLE IF NOT EXISTS op_log (
  canvas_id TEXT NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  forward JSONB NOT NULL,
  inverse JSONB NOT NULL,
  target_seq INTEGER,
  undone BOOLEAN NOT NULL DEFAULT FALSE,
  undone_by INTEGER,
  redoable BOOLEAN NOT NULL DEFAULT TRUE,
  label TEXT NOT NULL DEFAULT '',
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (canvas_id, seq)
);
`;

export class PgStore implements Store {
  private pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString });
  }

  async init(): Promise<void> {
    await this.pool.query(SCHEMA);
  }

  async ensureCanvas(id: string, name: string): Promise<void> {
    await this.pool.query('INSERT INTO canvases (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING', [
      id,
      name,
    ]);
  }

  async loadCanvas(id: string): Promise<PersistedCanvas | null> {
    const canvasRes = await this.pool.query('SELECT id, name FROM canvases WHERE id = $1', [id]);
    if (canvasRes.rowCount === 0) return null;
    const [shapes, connectors, members, ops] = await Promise.all([
      this.pool.query('SELECT * FROM shapes WHERE canvas_id = $1', [id]),
      this.pool.query('SELECT * FROM connectors WHERE canvas_id = $1', [id]),
      this.pool.query('SELECT user_id, name, role, color FROM members WHERE canvas_id = $1', [id]),
      this.pool.query('SELECT * FROM op_log WHERE canvas_id = $1 ORDER BY seq ASC', [id]),
    ]);
    return {
      id,
      name: canvasRes.rows[0].name,
      shapes: shapes.rows.map(
        (r): Shape => ({ id: r.id, kind: r.kind, x: r.x, y: r.y, w: r.w, h: r.h, z: r.z, color: r.color, text: r.text }),
      ),
      connectors: connectors.rows.map(
        (r): Connector => ({ id: r.id, from: r.from_id, to: r.to_id, fromSide: r.from_side, toSide: r.to_side, path: r.path }),
      ),
      members: members.rows.map(
        (r): Member => ({ userId: r.user_id, name: r.name, role: r.role, color: r.color }),
      ),
      ops: ops.rows.map(
        (r): LogEntry => ({
          seq: r.seq,
          userId: r.user_id,
          kind: r.kind,
          forward: r.forward,
          inverse: r.inverse,
          targetSeq: r.target_seq ?? undefined,
          undone: r.undone,
          undoneBy: r.undone_by ?? undefined,
          redoable: r.redoable,
          at: new Date(r.at).getTime(),
          label: r.label,
        }),
      ),
    };
  }

  async upsertMember(canvasId: string, m: Member): Promise<void> {
    await this.pool.query(
      `INSERT INTO members (canvas_id, user_id, name, role, color, updated_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (canvas_id, user_id)
       DO UPDATE SET name = EXCLUDED.name, role = EXCLUDED.role, color = EXCLUDED.color, updated_at = now()`,
      [canvasId, m.userId, m.name, m.role, m.color],
    );
  }

  async upsertShape(canvasId: string, s: Shape): Promise<void> {
    await this.pool.query(
      `INSERT INTO shapes (id, canvas_id, kind, x, y, w, h, z, color, text, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
       ON CONFLICT (canvas_id, id)
       DO UPDATE SET kind = EXCLUDED.kind, x = EXCLUDED.x, y = EXCLUDED.y, w = EXCLUDED.w, h = EXCLUDED.h,
                     z = EXCLUDED.z, color = EXCLUDED.color, text = EXCLUDED.text, updated_at = now()`,
      [canvasId, s.id, s.kind, s.x, s.y, s.w, s.h, s.z, s.color, s.text],
    );
  }

  async deleteShape(canvasId: string, shapeId: string): Promise<void> {
    await this.pool.query('DELETE FROM shapes WHERE canvas_id = $1 AND id = $2', [canvasId, shapeId]);
  }

  async upsertConnector(canvasId: string, c: Connector): Promise<void> {
    await this.pool.query(
      `INSERT INTO connectors (id, canvas_id, from_id, to_id, from_side, to_side, path, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now())
       ON CONFLICT (canvas_id, id)
       DO UPDATE SET from_id = EXCLUDED.from_id, to_id = EXCLUDED.to_id,
                     from_side = EXCLUDED.from_side, to_side = EXCLUDED.to_side,
                     path = EXCLUDED.path, updated_at = now()`,
      [canvasId, c.id, c.from, c.to, c.fromSide, c.toSide, JSON.stringify(c.path)],
    );
  }

  async deleteConnector(canvasId: string, connectorId: string): Promise<void> {
    await this.pool.query('DELETE FROM connectors WHERE canvas_id = $1 AND id = $2', [canvasId, connectorId]);
  }

  async appendOp(canvasId: string, e: LogEntry): Promise<void> {
    await this.pool.query(
      `INSERT INTO op_log (canvas_id, seq, user_id, kind, forward, inverse, target_seq, undone, undone_by, redoable, label, at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, to_timestamp($12 / 1000.0))`,
      [
        canvasId,
        e.seq,
        e.userId,
        e.kind,
        JSON.stringify(e.forward),
        JSON.stringify(e.inverse),
        e.targetSeq ?? null,
        e.undone,
        e.undoneBy ?? null,
        e.redoable,
        e.label,
        e.at,
      ],
    );
  }

  async updateOpFlags(
    canvasId: string,
    seq: number,
    flags: { undone?: boolean; undoneBy?: number | null; redoable?: boolean },
  ): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [canvasId, seq];
    if (flags.undone !== undefined) {
      sets.push(`undone = $${vals.length + 1}`);
      vals.push(flags.undone);
    }
    if (flags.undoneBy !== undefined) {
      sets.push(`undone_by = $${vals.length + 1}`);
      vals.push(flags.undoneBy);
    }
    if (flags.redoable !== undefined) {
      sets.push(`redoable = $${vals.length + 1}`);
      vals.push(flags.redoable);
    }
    if (sets.length === 0) return;
    await this.pool.query(`UPDATE op_log SET ${sets.join(', ')} WHERE canvas_id = $1 AND seq = $2`, vals);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
