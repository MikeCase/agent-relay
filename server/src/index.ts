import express from "express";
import type { Request, Response, NextFunction } from "express";
import path from "node:path";
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

// Build reverse lookup: key → tenant name
const keyToTenant = new Map<string, string>();
for (const [tenant, key] of Object.entries(config.tenants)) {
  keyToTenant.set(key, tenant);
}

// ── App setup ──────────────────────────────────────────────────────
const app = express();

// JSON body parser with size limit
app.use(express.json({ limit: config.maxPayloadBytes }));

// CORS — allow all origins for v0
app.use((_req: Request, res: Response, next: NextFunction) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Relay-Key");
  if (_req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
});

// Serve landing page at /
app.use(express.static(path.join(__dirname, "..", "public")));

// Auth middleware — multi-tenant
function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const hasAuth = Object.keys(config.tenants).length > 0;

  if (hasAuth) {
    const key = req.headers["x-relay-key"] as string | undefined;
    if (!key) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const tenant = keyToTenant.get(key);
    if (!tenant) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    res.locals.tenant = tenant;
  } else {
    // No auth configured — allow all (dev mode)
    res.locals.tenant = undefined;
  }
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
  res.status(200).json({ messages });
});

// GET /api/v1/health
app.get("/api/v1/health", (_req: Request, res: Response) => {
  res.status(200).json({
    status: "ok",
    uptime: process.uptime(),
    message_count: store.getMessageCount(),
  });
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

// ── Start ──────────────────────────────────────────────────────────
app.listen(config.port, config.host, () => {
  console.log(
    `[server] Agent Relay listening on ${config.host}:${config.port}`
  );
});
