import express from "express";
import type { Request, Response, NextFunction } from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { timingSafeEqual } from "node:crypto";
import { AdminStore } from "./store.js";
import { hashKey, generateKey } from "./auth.js";
import rateLimit from "express-rate-limit";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ADMIN_KEY = process.env.ADMIN_KEY;
const PORT = parseInt(process.env.PORT ?? "3002", 10);
const HOST = process.env.HOST ?? "0.0.0.0";
const DB_PATH = process.env.DB_PATH ?? "./relay.db";
const ADMIN_CORS_ORIGIN = process.env.ADMIN_CORS_ORIGIN || "http://localhost:3002";

const store = new AdminStore(DB_PATH);

// Generate bootstrap admin key if none exists (so admin works without ADMIN_KEY env)
if (!ADMIN_KEY && !store.hasBootstrapAdminKey()) {
  const key = generateKey();
  const hash = hashKey(key);
  store.setSetting("bootstrap.admin_key_hash", hash);
  console.log("");
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║              ADMIN KEY (auto-generated)                     ║");
  console.log("║                                                              ║");
  console.log(`║  ${key}  ║`);
  console.log("║                                                              ║");
  console.log("║  Use this to log into the admin dashboard.                   ║");
  console.log("║  Set ADMIN_KEY env var to use a fixed key instead.           ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");
  console.log("");
}

// Auto-migrate tenants from RELAY_AUTH_KEYS env var on startup
if (ADMIN_KEY && process.env.ADMIN_MIGRATE !== "false") {
  const result = store.migrateFromEnv(process.env.RELAY_AUTH_KEYS);
  if (result.migrated > 0) {
    console.log(`[admin] Auto-migrated ${result.migrated} tenants from RELAY_AUTH_KEYS`);
  }
}

function isValidUUID(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

const app = express();
app.use(express.json({ limit: "100kb" }));

// CORS
app.use((_req: Request, res: Response, next: NextFunction) => {
  res.setHeader("Access-Control-Allow-Origin", ADMIN_CORS_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Admin-Key");
  if (_req.method === "OPTIONS") { res.status(204).end(); return; }
  next();
});

// Cache-Control: no-store for API routes
app.use("/api", (_req: Request, res: Response, next: NextFunction) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});

// Serve dashboard at /
app.get("/", (_req: Request, res: Response) => {
  res.sendFile(path.join(__dirname, "..", "public", "admin.html"));
});

// Admin auth middleware
function adminAuth(req: Request, res: Response, next: NextFunction): void {
  const key = req.headers["x-admin-key"] as string | undefined;
  if (!key) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  // Check env ADMIN_KEY first
  if (ADMIN_KEY) {
    if (key.length !== ADMIN_KEY.length) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    try {
      if (!timingSafeEqual(Buffer.from(key), Buffer.from(ADMIN_KEY))) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
      next();
      return;
    } catch {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
  }
  // Fall back to bootstrap admin key in DB
  if (store.checkBootstrapAdminKey(key)) {
    next();
    return;
  }
  res.status(401).json({ error: "Unauthorized" });
}

// ── Admin API routes ──

const adminLimiter = rateLimit({
  windowMs: 60_000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Try again in a minute." },
});

const router = express.Router();
router.use(adminLimiter);
router.use(adminAuth);

router.get("/check", (_req: Request, res: Response) => {
  res.json({
    authenticated: true,
    stats: {
      tenants: store.getTenantCount(),
      agents: store.getAgentCount(),
      messages: store.getMessageCount(),
      uptime: process.uptime(),
    },
  });
});

router.get("/tenants", (_req: Request, res: Response) => {
  res.json({ tenants: store.listTenants() });
});

router.post("/tenants", (req: Request, res: Response) => {
  const { name, display_name } = req.body;
  if (!name || typeof name !== "string" || !/^[a-z0-9][a-z0-9-]{1,40}$/.test(name)) {
    res.status(400).json({ error: "Name must be 2-41 chars, lowercase, digits, and hyphens (must start with letter or digit)." });
    return;
  }
  if (store.getTenantByName(name)) {
    res.status(409).json({ error: `Tenant '${name}' already exists` });
    return;
  }
  const key = generateKey();
  const keyHash = hashKey(key);
  const keyPrefix = key.substring(0, 8);
  const tenant = store.createTenant(name, display_name || name);
  store.createTenantKey(tenant.id, keyHash, keyPrefix);
  res.status(201).json({
    id: tenant.id,
    name: tenant.name,
    display_name: tenant.display_name,
    key,
    key_prefix: keyPrefix,
    created_at: tenant.created_at,
  });
});

router.put("/tenants/:id", (req: Request, res: Response) => {
  if (!isValidUUID(String(req.params.id))) {
    res.status(400).json({ error: "Invalid ID format" });
    return;
  }
  const { display_name } = req.body;
  if (!display_name || typeof display_name !== "string") {
    res.status(400).json({ error: "Missing or invalid field: display_name" });
    return;
  }
  const tenant = store.updateTenant(String(req.params.id), display_name);
  if (!tenant) { res.status(404).json({ error: "Tenant not found" }); return; }
  res.json(tenant);
});

router.delete("/tenants/:id", (req: Request, res: Response) => {
  if (!isValidUUID(String(req.params.id))) {
    res.status(400).json({ error: "Invalid ID format" });
    return;
  }
  if (!store.deleteTenant(String(req.params.id))) {
    res.status(404).json({ error: "Tenant not found" });
    return;
  }
  res.json({ status: "deleted" });
});

router.post("/tenants/:id/rotate-key", (req: Request, res: Response) => {
  if (!isValidUUID(String(req.params.id))) {
    res.status(400).json({ error: "Invalid ID format" });
    return;
  }
  const tenant = store.getTenant(String(req.params.id));
  if (!tenant) { res.status(404).json({ error: "Tenant not found" }); return; }
  store.deactivateActiveKey(tenant.id);
  const key = generateKey();
  const keyHash = hashKey(key);
  const keyPrefix = key.substring(0, 8);
  store.createTenantKey(tenant.id, keyHash, keyPrefix);
  res.json({ key, key_prefix: keyPrefix });
});

router.get("/tenants/:id/keys", (req: Request, res: Response) => {
  if (!isValidUUID(String(req.params.id))) {
    res.status(400).json({ error: "Invalid ID format" });
    return;
  }
  res.json({ keys: store.listTenantKeys(String(req.params.id)) });
});

router.get("/tenants/:id/agents", (req: Request, res: Response) => {
  if (!isValidUUID(String(req.params.id))) {
    res.status(400).json({ error: "Invalid ID format" });
    return;
  }
  res.json({ agents: store.listTenantAgents(String(req.params.id)) });
});

router.post("/tenants/:id/agents", (req: Request, res: Response) => {
  if (!isValidUUID(String(req.params.id))) {
    res.status(400).json({ error: "Invalid ID format" });
    return;
  }
  const { pubkey, display_name } = req.body;
  if (!pubkey || !display_name) {
    res.status(400).json({ error: "Missing required fields: pubkey, display_name" });
    return;
  }
  try {
    const agent = store.createAgent(String(req.params.id), pubkey, display_name);
    res.status(201).json(agent);
  } catch (err: any) {
    if (err.message?.includes?.("UNIQUE constraint")) {
      res.status(409).json({ error: "Agent with this pubkey already registered in this tenant" });
    } else if (err.message?.includes?.("FOREIGN KEY")) {
      res.status(404).json({ error: "Tenant not found" });
    } else {
      console.error(`[admin] Agent creation error: ${err.message}`);
      res.status(500).json({ error: "Failed to create agent" });
    }
  }
});

router.put("/tenants/:id/agents/:agentId", (req: Request, res: Response) => {
  if (!isValidUUID(String(req.params.id))) {
    res.status(400).json({ error: "Invalid ID format" });
    return;
  }
  if (!isValidUUID(String(req.params.agentId))) {
    res.status(400).json({ error: "Invalid ID format" });
    return;
  }
  const { display_name } = req.body;
  if (!display_name || typeof display_name !== "string") {
    res.status(400).json({ error: "Missing or invalid field: display_name" });
    return;
  }
  const agent = store.updateAgent(String(req.params.agentId), String(req.params.id), display_name);
  if (!agent) { res.status(404).json({ error: "Agent not found" }); return; }
  res.json(agent);
});

router.delete("/tenants/:id/agents/:agentId", (req: Request, res: Response) => {
  if (!isValidUUID(String(req.params.id))) {
    res.status(400).json({ error: "Invalid ID format" });
    return;
  }
  if (!isValidUUID(String(req.params.agentId))) {
    res.status(400).json({ error: "Invalid ID format" });
    return;
  }
  if (!store.deleteAgent(String(req.params.agentId), String(req.params.id))) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }
  res.json({ status: "deleted" });
});

router.get("/agents", (_req: Request, res: Response) => {
  res.json({ agents: store.listAllAgents() });
});

router.get("/stats", (_req: Request, res: Response) => {
  res.json({
    tenant_count: store.getTenantCount(),
    agent_count: store.getAgentCount(),
    message_count: store.getMessageCount(),
    uptime: process.uptime(),
  });
});

router.post("/migrate", (_req: Request, res: Response) => {
  const result = store.migrateFromEnv(process.env.RELAY_AUTH_KEYS);
  res.json(result);
});

const hasAdmin = ADMIN_KEY || store.hasBootstrapAdminKey();
if (hasAdmin) {
  app.use("/api/v1/admin", router);
} else {
  app.use("/api/v1/admin", (_req, res) => res.status(404).json({ error: "Not found" }));
  console.log("[admin] ADMIN_KEY not set — admin API disabled. Set ADMIN_KEY to enable the dashboard.");
}

// ── Global error handler ──

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  const message = process.env.NODE_ENV === "production"
    ? "Internal server error"
    : err.message || "Internal server error";
  console.error(`[admin] Error: ${err.message}`);
  res.status(500).json({ error: message });
});

// ── Start ──

app.listen(PORT, HOST, () => {
  console.log(`[admin] Agent Relay Admin listening on ${HOST}:${PORT}`);
  if (!ADMIN_KEY && store.hasBootstrapAdminKey()) {
    console.log("[admin] Using auto-generated admin key from database. Set ADMIN_KEY env var for a fixed key.");
  }
});
