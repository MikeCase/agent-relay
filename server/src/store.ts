import Database from "better-sqlite3";
import { v4 as uuidv4 } from "uuid";
import { createHash, randomBytes } from "node:crypto";
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

    // Settings table (v0.3) — key-value store
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
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

  // ── Settings ──

  getSetting(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value;
  }

  setSetting(key: string, value: string): void {
    this.db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(key, value);
  }

  // ── Bootstrap auth generation ──

  isTenantsEmpty(): boolean {
    const row = this.db.prepare("SELECT COUNT(*) as count FROM tenants").get() as { count: number };
    return row.count === 0;
  }

  hashKey(key: string): string {
    return createHash("sha256").update("agent-relay-key-v1:" + key).digest("hex");
  }

  /** Ensure a bootstrap admin key exists in the DB. Returns the plaintext key if newly generated, null if one already existed. */
  ensureBootstrapAdminKey(): string | null {
    if (this.getSetting("bootstrap.admin_key_hash")) return null;
    const adminKey = randomBytes(32).toString("hex");
    const adminKeyHash = this.hashKey(adminKey);
    this.setSetting("bootstrap.admin_key_hash", adminKeyHash);
    return adminKey;
  }

  generateBootstrapTenant(): { tenantKey: string; tenantName: string } {
    const tenantName = "default";
    const tenantDisplay = "Default";
    const tenantKey = randomBytes(32).toString("hex");
    const tenantKeyHash = this.hashKey(tenantKey);
    const tenantKeyPrefix = tenantKey.substring(0, 8);

    const tenantId = this.createBootstrapTenant(tenantName, tenantDisplay);
    this.createBootstrapKey(tenantId, tenantKeyHash, tenantKeyPrefix);

    return { tenantKey, tenantName: tenantDisplay };
  }

  private createBootstrapTenant(name: string, displayName: string): string {
    const id = uuidv4();
    this.db.prepare("INSERT INTO tenants (id, name, display_name) VALUES (?, ?, ?)").run(id, name, displayName);
    return id;
  }

  private createBootstrapKey(tenantId: string, keyHash: string, keyPrefix: string): void {
    this.db.prepare("INSERT INTO tenant_keys (id, tenant_id, key_hash, key_prefix) VALUES (?, ?, ?, ?)")
      .run(uuidv4(), tenantId, keyHash, keyPrefix);
  }
}
