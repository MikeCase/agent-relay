import Database from "better-sqlite3";
import { v4 as uuidv4 } from "uuid";
import type { TenantRow, TenantResponse, AgentRow, TenantKeyRow } from "./types.js";

export class AdminStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.initSchema();
  }

  private initSchema(): void {
    // Create admin tables if they don't exist (the relay may have created them)
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

  // ── Tenants ──

  createTenant(name: string, displayName: string): TenantRow {
    const id = uuidv4();
    this.db.prepare("INSERT INTO tenants (id, name, display_name) VALUES (?, ?, ?)").run(id, name, displayName);
    return this.db.prepare("SELECT * FROM tenants WHERE id = ?").get(id) as TenantRow;
  }

  getTenant(id: string): TenantRow | undefined {
    return this.db.prepare("SELECT * FROM tenants WHERE id = ?").get(id) as TenantRow | undefined;
  }

  getTenantByName(name: string): { id: string; name: string } | undefined {
    return this.db.prepare("SELECT id, name FROM tenants WHERE name = ?").get(name) as any;
  }

  listTenants(): TenantResponse[] {
    return this.db.prepare(`
      SELECT t.id, t.name, t.display_name,
        (SELECT key_prefix FROM tenant_keys WHERE tenant_id = t.id AND is_active = 1 LIMIT 1) as key_prefix,
        (SELECT COUNT(*) FROM agents WHERE tenant_id = t.id) as agent_count,
        (SELECT COUNT(*) FROM messages WHERE tenant = t.name) as message_count,
        t.created_at
      FROM tenants t ORDER BY t.created_at DESC
    `).all() as TenantResponse[];
  }

  updateTenant(id: string, displayName: string): TenantRow | undefined {
    this.db.prepare("UPDATE tenants SET display_name = ?, updated_at = datetime('now') WHERE id = ?").run(displayName, id);
    return this.getTenant(id);
  }

  deleteTenant(id: string): boolean {
    return this.db.prepare("DELETE FROM tenants WHERE id = ?").run(id).changes > 0;
  }

  getTenantCount(): number {
    return (this.db.prepare("SELECT COUNT(*) as count FROM tenants").get() as any).count;
  }

  // ── Tenant Keys ──

  createTenantKey(tenantId: string, keyHash: string, keyPrefix: string): void {
    this.db.prepare("INSERT INTO tenant_keys (id, tenant_id, key_hash, key_prefix) VALUES (?, ?, ?, ?)")
      .run(uuidv4(), tenantId, keyHash, keyPrefix);
  }

  deactivateActiveKey(tenantId: string): void {
    this.db.prepare(
      "UPDATE tenant_keys SET is_active = 0, rotated_at = datetime('now') WHERE tenant_id = ? AND is_active = 1"
    ).run(tenantId);
  }

  listTenantKeys(tenantId: string): TenantKeyRow[] {
    return this.db.prepare(
      "SELECT id, key_prefix, is_active, created_at, rotated_at FROM tenant_keys WHERE tenant_id = ? ORDER BY created_at DESC"
    ).all(tenantId) as TenantKeyRow[];
  }

  getActiveKeyCount(): number {
    return (this.db.prepare("SELECT COUNT(*) as count FROM tenant_keys WHERE is_active = 1").get() as any).count;
  }

  // ── Agents ──

  createAgent(tenantId: string, pubkey: string, displayName: string): AgentRow {
    const id = uuidv4();
    this.db.prepare("INSERT INTO agents (id, tenant_id, pubkey, display_name) VALUES (?, ?, ?, ?)")
      .run(id, tenantId, pubkey, displayName);
    return this.db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as AgentRow;
  }

  listTenantAgents(tenantId: string): AgentRow[] {
    return this.db.prepare(
      "SELECT * FROM agents WHERE tenant_id = ? ORDER BY last_seen_at DESC NULLS LAST, created_at DESC"
    ).all(tenantId) as AgentRow[];
  }

  listAllAgents(): (AgentRow & { tenant_name: string })[] {
    return this.db.prepare(`
      SELECT a.*, t.name as tenant_name
      FROM agents a JOIN tenants t ON a.tenant_id = t.id
      ORDER BY a.last_seen_at DESC NULLS LAST, a.created_at DESC
    `).all() as any[];
  }

  updateAgent(agentId: string, displayName: string): AgentRow | undefined {
    this.db.prepare("UPDATE agents SET display_name = ? WHERE id = ?").run(displayName, agentId);
    return this.db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId) as AgentRow | undefined;
  }

  deleteAgent(agentId: string): boolean {
    return this.db.prepare("DELETE FROM agents WHERE id = ?").run(agentId).changes > 0;
  }

  getAgentCount(): number {
    return (this.db.prepare("SELECT COUNT(*) as count FROM agents").get() as any).count;
  }

  getMessageCount(): number {
    return (this.db.prepare("SELECT COUNT(*) as count FROM messages").get() as any).count;
  }

  close(): void {
    this.db.close();
  }
}

