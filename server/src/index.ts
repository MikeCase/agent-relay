import express from "express";
import type { Request, Response, NextFunction } from "express";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { MessageStore } from "./store.js";
import type { SendRequest, ServerConfig } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Config from env ────────────────────────────────────────────────
function loadConfig(): ServerConfig {
  // Read RELAY_AUTH_KEYS (new) or RELAY_AUTH_KEY (legacy)
  let tenants: Record<string, string> = {};
  const authKeysEnv = process.env.RELAY_AUTH_KEYS;
  const authKeyEnv = process.env.RELAY_AUTH_KEY;

  if (authKeysEnv) {
    try {
      tenants = JSON.parse(authKeysEnv);
    } catch {
      console.error("RELAY_AUTH_KEYS must be a valid JSON object");
      process.exit(1);
    }
  } else if (authKeyEnv) {
    tenants = { default: authKeyEnv };
  }

  return {
    port: parseInt(process.env.PORT ?? "3001", 10),
    host: process.env.HOST ?? "0.0.0.0",
    dbPath: process.env.DB_PATH ?? "./relay.db",
    tenants,
    messageTtlDays: parseInt(process.env.MESSAGE_TTL_DAYS ?? "7", 10),
    maxPayloadBytes: parseInt(process.env.MAX_PAYLOAD_BYTES ?? "1048576", 10),
  };
}

const config = loadConfig();
const store = new MessageStore(config.dbPath);

// Ensure a bootstrap admin key always exists (so admin dashboard works without ADMIN_KEY env)
const adminKey = store.ensureBootstrapAdminKey();
if (adminKey) {
  console.log("");
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║              ADMIN KEY (auto-generated)                     ║");
  console.log("║                                                              ║");
  console.log(`║  ${adminKey}  ║`);
  console.log("║                                                              ║");
  console.log("║  Use this to log into the admin dashboard.                   ║");
  console.log("║  Set ADMIN_KEY env var to use a fixed key instead.           ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");
  console.log("");
}

// Bootstrap: generate first tenant if none configured and no env var auth
const hasEnvAuth = Object.keys(config.tenants).length > 0;
if (!hasEnvAuth && store.isTenantsEmpty()) {
  const boot = store.generateBootstrapTenant();
  console.log("");
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║              TENANT KEY (auto-generated)                    ║");
  console.log("║                                                              ║");
  console.log(`║  ${boot.tenantName} → ${boot.tenantKey}  ║`);
  console.log("║                                                              ║");
  console.log("║  Configure your agents with this key.                        ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");
  console.log("");
}

// ── App setup ──────────────────────────────────────────────────────
const app = express();

// JSON body parser with size limit
app.use(express.json({ limit: config.maxPayloadBytes }));

// CORS — allow all origins for v0
app.use((_req: Request, res: Response, next: NextFunction) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Relay-Key");
  if (_req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
});

// Serve landing page at /
app.use(express.static(path.join(__dirname, "..", "public")));

// GET /api/v1/health — public, no auth required (used by Docker HEALTHCHECK)
app.get("/api/v1/health", (_req: Request, res: Response) => {
  res.status(200).json({
    status: "ok",
    uptime: process.uptime(),
    message_count: store.getMessageCount(),
  });
});

// Auth middleware — multi-tenant (env vars + DB keys)
function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const hasAuth = Object.keys(config.tenants).length > 0;
  const hasDbAuth = store.getActiveKeyCount() > 0;

  if (hasAuth || hasDbAuth) {
    const key = req.headers["x-relay-key"] as string | undefined;
    if (!key) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    // Check env vars first (fast path)
    const envTenantName = Object.entries(config.tenants).find(([, v]) => v === key)?.[0];
    if (envTenantName) {
      res.locals.tenant = envTenantName;
      res.locals.tenantId = store.ensureTenant(envTenantName);
      next();
      return;
    }
    // Check DB-backed keys
    if (hasDbAuth) {
      const hash = createHash("sha256")
        .update("agent-relay-key-v1:" + key)
        .digest("hex");
      const activeKeys = store.getAllActiveKeys();
      const match = activeKeys.find(k => k.key_hash === hash);
      if (match) {
        res.locals.tenant = match.tenant_name;
        res.locals.tenantId = match.tenant_id;
        next();
        return;
      }
    }
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  // No auth configured — dev mode
  res.locals.tenant = undefined;
  res.locals.tenantId = undefined;
  next();
}

app.use(authMiddleware);

// API routes get no-store cache control
app.use("/api", (_req: Request, res: Response, next: NextFunction) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});

// ── Routes ─────────────────────────────────────────────────────────

// POST /api/v1/send
app.post("/api/v1/send", (req: Request, res: Response) => {
  const body = req.body as SendRequest;

  if (!body.sender || typeof body.sender !== "string") {
    res.status(400).json({ error: "Missing or invalid field: sender" });
    return;
  }
  if (!body.recipient || typeof body.recipient !== "string") {
    res.status(400).json({ error: "Missing or invalid field: recipient" });
    return;
  }
  if (!body.payload || typeof body.payload !== "string") {
    res.status(400).json({ error: "Missing or invalid field: payload" });
    return;
  }

  const payloadBytes = Buffer.byteLength(body.payload, "utf-8");
  if (payloadBytes > config.maxPayloadBytes) {
    res.status(413).json({
      error: `Payload exceeds maximum size of ${config.maxPayloadBytes} bytes`,
    });
    return;
  }

  const id = store.insertMessage(body.sender, body.recipient, body.payload, res.locals.tenant as string | undefined);

  // Track sender last seen
  if (res.locals.tenantId) {
    store.upsertAgent(res.locals.tenantId, body.sender, body.sender_alias);
  }

  res.status(201).json({ id, status: "stored" });
});

// GET /api/v1/poll
app.get("/api/v1/poll", (req: Request, res: Response) => {
  const recipient = req.query.recipient as string | undefined;
  if (!recipient) {
    res.status(400).json({ error: "Missing required query param: recipient" });
    return;
  }

  const since = req.query.since as string | undefined;
  const messages = store.pollMessages(recipient, since, res.locals.tenant as string | undefined);

  // Track recipient last seen
  if (res.locals.tenantId) {
    store.upsertAgent(res.locals.tenantId, recipient);
  }

  res.status(200).json({ messages });
});

// ── Periodic cleanup ───────────────────────────────────────────────
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

const cleanupTimer = setInterval(() => {
  const before = store.getMessageCount();
  store.cleanup(config.messageTtlDays);
  const after = store.getMessageCount();
  const deleted = before - after;
  console.log(
    `[cleanup] deleted ${deleted} messages older than ${config.messageTtlDays} days (${after} remaining)`
  );
}, CLEANUP_INTERVAL_MS);

// Don't let the timer keep the process alive
cleanupTimer.unref();

// ── Graceful shutdown ──────────────────────────────────────────────
function shutdown(signal: string): void {
  console.log(`[server] received ${signal}, shutting down...`);
  clearInterval(cleanupTimer);
  store.close();
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// ── Global error handler ────────────────────────────────────────────
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  const message = process.env.NODE_ENV === "production"
    ? "Internal server error"
    : err.message || "Internal server error";
  console.error(`[server] Error: ${err.message}`);
  res.status(500).json({ error: message });
});

// ── Start ──────────────────────────────────────────────────────────
app.listen(config.port, config.host, () => {
  console.log(
    `[server] Agent Relay listening on ${config.host}:${config.port}`
  );
});
