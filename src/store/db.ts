import { DatabaseSync } from "node:sqlite";

export type Db = DatabaseSync;

export function openDb(dbPath: string): Db {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  migrate(db);
  return db;
}

function migrate(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings(
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS bots(
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      avatar TEXT,
      persona TEXT NOT NULL,
      driver TEXT NOT NULL,
      model TEXT,
      approval_mode TEXT NOT NULL,
      workspace TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS threads(
      id TEXT PRIMARY KEY,
      bot_id TEXT NOT NULL REFERENCES bots(id),
      cli_session_id TEXT,
      title TEXT,
      created_at TEXT NOT NULL,
      last_active_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_threads_bot ON threads(bot_id, last_active_at);
    CREATE TABLE IF NOT EXISTS turns(
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES threads(id),
      status TEXT NOT NULL,
      started_at TEXT,
      ended_at TEXT,
      stop_reason TEXT,
      error TEXT
    );
    CREATE TABLE IF NOT EXISTS events(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL,
      turn_id TEXT,
      seq INTEGER NOT NULL,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_thread ON events(thread_id, seq);
    CREATE TABLE IF NOT EXISTS approvals(
      id TEXT PRIMARY KEY,
      bot_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      turn_id TEXT,
      tool TEXT NOT NULL,
      input_json TEXT NOT NULL,
      decision TEXT,
      source TEXT,
      requested_at TEXT NOT NULL,
      decided_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_approvals_thread ON approvals(thread_id, decided_at);
  `);
}

export interface BotRow {
  id: string;
  name: string;
  avatar: string | null;
  persona: string;
  driver: string;
  model: string | null;
  approval_mode: string;
  workspace: string;
  status: string;
  created_at: string;
}

export interface ThreadRow {
  id: string;
  bot_id: string;
  cli_session_id: string | null;
  title: string | null;
  created_at: string;
  last_active_at: string;
}

export interface TurnRow {
  id: string;
  thread_id: string;
  status: string;
  started_at: string | null;
  ended_at: string | null;
  stop_reason: string | null;
  error: string | null;
}

export interface EventRow {
  id: number;
  thread_id: string;
  turn_id: string | null;
  seq: number;
  type: string;
  payload_json: string;
  at: string;
}

export interface ApprovalRow {
  id: string;
  bot_id: string;
  thread_id: string;
  turn_id: string | null;
  tool: string;
  input_json: string;
  decision: string | null;
  source: string | null;
  requested_at: string;
  decided_at: string | null;
}

export class Store {
  constructor(private db: Db) {}

  createBot(bot: BotRow): void {
    this.db
      .prepare(
        `INSERT INTO bots(id, name, avatar, persona, driver, model, approval_mode, workspace, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(bot.id, bot.name, bot.avatar, bot.persona, bot.driver, bot.model, bot.approval_mode, bot.workspace, bot.status, bot.created_at);
  }

  listBots(): BotRow[] {
    return this.db.prepare(`SELECT * FROM bots ORDER BY created_at`).all() as unknown as BotRow[];
  }

  getBot(id: string): BotRow | undefined {
    return this.db.prepare(`SELECT * FROM bots WHERE id = ?`).get(id) as BotRow | undefined;
  }

  updateBot(id: string, patch: Partial<Pick<BotRow, "name" | "avatar" | "persona" | "model" | "approval_mode" | "status">>): void {
    const sets = Object.keys(patch).map((k) => `${k} = ?`);
    if (sets.length === 0) return;
    this.db
      .prepare(`UPDATE bots SET ${sets.join(", ")} WHERE id = ?`)
      .run(...Object.values(patch), id);
  }

  deleteBot(id: string): void {
    this.db.prepare(`DELETE FROM bots WHERE id = ?`).run(id);
  }

  createThread(thread: ThreadRow): void {
    this.db
      .prepare(
        `INSERT INTO threads(id, bot_id, cli_session_id, title, created_at, last_active_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(thread.id, thread.bot_id, thread.cli_session_id, thread.title, thread.created_at, thread.last_active_at);
  }

  getThread(id: string): ThreadRow | undefined {
    return this.db.prepare(`SELECT * FROM threads WHERE id = ?`).get(id) as ThreadRow | undefined;
  }

  listThreads(botId: string): ThreadRow[] {
    return this.db
      .prepare(`SELECT * FROM threads WHERE bot_id = ? ORDER BY last_active_at DESC`)
      .all(botId) as unknown as ThreadRow[];
  }

  setThreadSession(id: string, cliSessionId: string): void {
    this.db.prepare(`UPDATE threads SET cli_session_id = ? WHERE id = ?`).run(cliSessionId, id);
  }

  touchThread(id: string): void {
    this.db.prepare(`UPDATE threads SET last_active_at = ? WHERE id = ?`).run(new Date().toISOString(), id);
  }

  deleteThreadsOfBot(botId: string): void {
    this.db.prepare(`DELETE FROM threads WHERE bot_id = ?`).run(botId);
  }

  createTurn(turn: TurnRow): void {
    this.db
      .prepare(`INSERT INTO turns(id, thread_id, status) VALUES (?, ?, ?)`)
      .run(turn.id, turn.thread_id, turn.status);
  }

  setTurnStatus(id: string, status: string, extra?: { stopReason?: string; error?: string }): void {
    const now = new Date().toISOString();
    if (status === "running") {
      this.db.prepare(`UPDATE turns SET status = ?, started_at = ? WHERE id = ?`).run(status, now, id);
    } else {
      this.db
        .prepare(`UPDATE turns SET status = ?, ended_at = ?, stop_reason = ?, error = ? WHERE id = ?`)
        .run(status, now, extra?.stopReason ?? null, extra?.error ?? null, id);
    }
  }

  appendEvent(threadId: string, turnId: string | null, type: string, payload: unknown): EventRow {
    const next =
      (this.db.prepare(`SELECT COALESCE(MAX(seq), 0) AS s FROM events WHERE thread_id = ?`).get(threadId) as { s: number }).s + 1;
    const at = new Date().toISOString();
    this.db
      .prepare(`INSERT INTO events(thread_id, turn_id, seq, type, payload_json, at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(threadId, turnId, next, type, JSON.stringify(payload ?? {}), at);
    return { id: 0, thread_id: threadId, turn_id: turnId, seq: next, type, payload_json: JSON.stringify(payload ?? {}), at };
  }

  listEvents(threadId: string): EventRow[] {
    return this.db
      .prepare(`SELECT * FROM events WHERE thread_id = ? ORDER BY seq`)
      .all(threadId) as unknown as EventRow[];
  }

  deleteEventsOfBot(botId: string): void {
    this.db
      .prepare(`DELETE FROM events WHERE thread_id IN (SELECT id FROM threads WHERE bot_id = ?)`)
      .run(botId);
  }

  createApproval(a: ApprovalRow): void {
    this.db
      .prepare(
        `INSERT INTO approvals(id, bot_id, thread_id, turn_id, tool, input_json, requested_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(a.id, a.bot_id, a.thread_id, a.turn_id, a.tool, a.input_json, a.requested_at);
  }

  decideApproval(id: string, decision: string, source: string): ApprovalRow | undefined {
    const result = this.db
      .prepare(`UPDATE approvals SET decision = ?, source = ?, decided_at = ? WHERE id = ? AND decision IS NULL`)
      .run(decision, source, new Date().toISOString(), id);
    if (result.changes === 0) return undefined;
    return this.getApproval(id);
  }

  getApproval(id: string): ApprovalRow | undefined {
    return this.db.prepare(`SELECT * FROM approvals WHERE id = ?`).get(id) as ApprovalRow | undefined;
  }

  pendingApprovals(): ApprovalRow[] {
    return this.db
      .prepare(`SELECT * FROM approvals WHERE decision IS NULL ORDER BY requested_at`)
      .all() as unknown as ApprovalRow[];
  }
}

