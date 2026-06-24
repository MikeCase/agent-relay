import express from "express";
import type { Request, Response, NextFunction } from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AdminStore } from "./store.js";
import { hashKey, generateKey } from "./auth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ADMIN_KEY = process.env.ADMIN_KEY;
const PORT = parseInt(process.env.PORT ?? "3002", 10);
const HOST = process.env.HOST ?? "0.0.0.0";
const DB_PATH = process.env.DB_PATH ?? "./relay.db";

if (!ADMIN_KEY) {
  console.error("ADMIN_KEY environment variable is required");
  process.exit(1);
}

const store = new AdminStore(DB_PATH);

const app = express();
app.use(express.json());

// CORS
app.use((_req: Request, res: Response, next: NextFunction) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
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
  if (!key || key !== ADMIN_KEY) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

// ── Admin API routes ──

const router = express.Router();
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
  if (!name || typeof name !== "string") {
    res.status(400).json({ error: "Missing or invalid field: name" });
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
  if (!store.deleteTenant(String(req.params.id))) {
    res.status(404).json({ error: "Tenant not found" });
    return;
  }
  res.json({ status: "deleted" });
});

router.post("/tenants/:id/rotate-key", (req: Request, res: Response) => {
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
  res.json({ keys: store.listTenantKeys(String(req.params.id)) });
});

router.get("/tenants/:id/agents", (req: Request, res: Response) => {
  res.json({ agents: store.listTenantAgents(String(req.params.id)) });
});

router.post("/tenants/:id/agents", (req: Request, res: Response) => {
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
  const { display_name } = req.body;
  if (!display_name || typeof display_name !== "string") {
    res.status(400).json({ error: "Missing or invalid field: display_name" });
    return;
  }
  const agent = store.updateAgent(String(req.params.agentId), display_name);
  if (!agent) { res.status(404).json({ error: "Agent not found" }); return; }
  res.json(agent);
});

router.delete("/tenants/:id/agents/:agentId", (req: Request, res: Response) => {
  if (!store.deleteAgent(String(req.params.agentId))) {
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

app.use("/api/v1/admin", router);

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
});
