import Database from "better-sqlite3";
import { v4 as uuidv4 } from "uuid";
import type { StoredMessage, DbActiveKey } from "./types.js";

export class MessageStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        sender TEXT NOT NULL,
        recipient TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_recipient ON messages(recipient);
      CREATE INDEX IF NOT EXISTS idx_created ON messages(created_at);
    `);
    this.migrateSchema();
  }

  private migrateSchema(): void {
    // Add tenant column if it doesn't exist (backward compat with existing DBs)
    try {
      this.db.exec("ALTER TABLE messages ADD COLUMN tenant TEXT");
    } catch {
      // Column already exists — ignore
    }
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_tenant ON messages(tenant)");

    // Admin panel tables (v0.2) — kept so the admin service can use them
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tenants (
        id TEXT PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        display_name TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS tenant_keys (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        key_hash TEXT NOT NULL,
        key_prefix TEXT NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        rotated_at TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_key ON tenant_keys(tenant_id) WHERE is_active = 1;
      CREATE INDEX IF NOT EXISTS idx_tenant_keys_lookup ON tenant_keys(key_hash);
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        pubkey TEXT NOT NULL,
        display_name TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_seen_at TEXT,
        UNIQUE(tenant_id, pubkey)
      );
      CREATE INDEX IF NOT EXISTS idx_agents_tenant ON agents(tenant_id);
      CREATE INDEX IF NOT EXISTS idx_agents_pubkey ON agents(pubkey);
    `);
  }

  insertMessage(sender: string, recipient: string, payload: string, tenant?: string): string {
    const id = uuidv4();
    const stmt = this.db.prepare(
      "INSERT INTO messages (id, sender, recipient, payload, tenant) VALUES (?, ?, ?, ?, ?)"
    );
    stmt.run(id, sender, recipient, payload, tenant ?? null);
    return id;
  }

  pollMessages(recipient: string, since?: string, tenant?: string): StoredMessage[] {
    const exclusionWindow = 30; // seconds of clock skew tolerance

    let rows: StoredMessage[];
    if (since) {
      const stmt = this.db.prepare(`
        SELECT id, sender, recipient, payload, created_at
        FROM messages
        WHERE recipient = ?
          AND created_at > datetime(?, ? || ' seconds')
          ${tenant ? "AND tenant = ?" : ""}
        ORDER BY created_at ASC
      `);
      const params: (string | number)[] = [recipient, since, `-${exclusionWindow}`];
      if (tenant) params.push(tenant);
      rows = stmt.all(...params) as StoredMessage[];
    } else {
      const stmt = this.db.prepare(`
        SELECT id, sender, recipient, payload, created_at
        FROM messages
        WHERE recipient = ?
          ${tenant ? "AND tenant = ?" : ""}
        ORDER BY created_at ASC
      `);
      const params: string[] = [recipient];
      if (tenant) params.push(tenant);
      rows = stmt.all(...params) as StoredMessage[];
    }

    if (rows.length > 0) {
      const ids = rows.map((r) => r.id);
      const deleteStmt = this.db.prepare(
        "DELETE FROM messages WHERE id = ?"
      );
      const deleteMany = this.db.transaction((ids: string[]) => {
        for (const id of ids) {
          deleteStmt.run(id);
        }
      });
      deleteMany(ids);
    }

    return rows;
  }

  getMessageCount(): number {
    const row = this.db.prepare(
      "SELECT COUNT(*) as count FROM messages"
    ).get() as { count: number };
    return row.count;
  }

  cleanup(ttlDays: number): void {
    this.db.prepare(
      "DELETE FROM messages WHERE created_at < datetime('now', ? || ' days')"
    ).run(`-${ttlDays}`);
  }

  // ── Auth key lookup ──

  getAllActiveKeys(): DbActiveKey[] {
    return this.db.prepare(`
      SELECT tk.key_hash, tk.tenant_id, t.name as tenant_name
      FROM tenant_keys tk JOIN tenants t ON tk.tenant_id = t.id
      WHERE tk.is_active = 1
    `).all() as DbActiveKey[];
  }

  getActiveKeyCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) as count FROM tenant_keys WHERE is_active = 1").get() as { count: number };
    return row.count;
  }

  // ── Agent tracking ──

  updateAgentLastSeen(pubkey: string): void {
    this.db.prepare(
      "UPDATE agents SET last_seen_at = datetime('now') WHERE pubkey = ?"
    ).run(pubkey);
  }

  close(): void {
    this.db.close();
  }
}
