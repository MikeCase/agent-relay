# Agent Relay — Specification v0.1

## 1. Overview

A relay server + MCP client that lets OpenCode agents on different machines
exchange end-to-end encrypted messages. Two parts:

- **`agent-relay-server`** — HTTP server (untrusted) that stores and forwards
  encrypted message blobs. No auth, no crypto knowledge. One SQLite database.
- **`agent-relay-mcp`** — MCP server that each agent runs locally. Provides
  `send_message`, `check_inbox`, and `agent_pair` tools. Handles all crypto.

---

## 2. File Structure

```
agent-relay/
├── server/                 # Relay server (deployable)
│   ├── package.json
│   ├── src/
│   │   ├── index.ts        # Express/Fastify entry, routes
│   │   ├── store.ts        # SQLite read/write
│   │   └── types.ts        # Shared types
│   └── Dockerfile          # Optional, for deployment
├── mcp/                    # MCP client plugin
│   ├── package.json
│   ├── src/
│   │   ├── index.ts        # MCP server entry, tool handlers
│   │   ├── crypto.ts       # Keygen, sign, verify, encrypt, decrypt
│   │   ├── relay.ts        # HTTP client to relay server
│   │   └── types.ts        # Shared types
│   └── bin/
│       └── agent-relay-mcp # CLI entry (npx-runnable)
├── PLAN.md
├── SPEC.md
└── README.md
```

---

## 3. Key Generation & Identity

### Key format

Each agent generates an Ed25519 keypair on first run. Keys are stored in the
agent's config directory:

```
~/.config/agent-relay/
├── keypair.json       # { "publicKey": "<base64>", "privateKey": "<base64>" }
└── peers.json         # { "<peer-id>": "<base64-public-key>", ... }
```

- `publicKey` / `privateKey`: Ed25519 key bytes, base64-encoded (not base64url).
  Standard crypto_box standard.

### Fingerprint

The public key fingerprint is the SHA-256 hash of the raw public key bytes,
encoded in hex, truncated to the first 16 characters:

```
fingerprint = sha256(publicKeyRaw).hex()[0..16]
```

Displayed as: `a3f1c8e92b47d012`

### Peer ID

A peer is identified by its full base64-encoded public key. The display name is
an alias stored in `peers.json`:

```json
{
  "peers": {
    "AAAA...base64...": "vps-sysadmin",
    "BBBB...base64...": "desktop-admin"
  }
}
```

The alias is local to each agent — it's how you refer to a peer in conversation
without typing their full key. Aliases are set during pairing.

---

## 4. Crypto Protocol

Every message goes through:

```
plaintext (JSON)
  → encrypt(plaintext, recipientPubKey, senderPrivKey) → ciphertext
  → sign(ciphertext, senderPrivKey) → signedBlob
  → base64 encode → wire format
```

On receive:

```
wire format (base64)
  → decode → signedBlob
  → verify(signedBlob, senderPubKey) → ciphertext (or reject)
  → decrypt(ciphertext, recipientPrivKey, senderPubKey) → plaintext JSON
```

### Encryption: NaCl box (curve25519-xsalsa20-poly1305)

Uses `tweetnacl` or `@noble/ciphers` / libsodium binding.

```
encrypt(plaintext: Uint8Array, recipientPubKey: Uint8Array, senderPrivKey: Uint8Array): Uint8Array

1. Generate ephemeral curve25519 keypair (ek, ePK)
2. Shared secret = scalarMult(ek, recipientPubKey)
3. Nonce = random 24 bytes
4. ciphertext = secretbox(plaintext, nonce, sharedSecret)
5. Return concat(ePK, nonce, ciphertext)
```

Decryption reverses: extract ePK, compute shared secret from
`scalarMult(recipientPrivKey, ePK)`, verify and decrypt with secretbox.

### Signing: Ed25519

```
sign(data: Uint8Array, privKey: Uint8Array): Uint8Array
  → Returns detached signature (64 bytes)

verify(data: Uint8Array, sig: Uint8Array, pubKey: Uint8Array): boolean
  → True if signature is valid for data under pubKey
```

### Wire format

What gets sent to the relay:

```json
{
  "sender": "<base64 sender public key>",
  "recipient": "<base64 recipient public key>",
  "payload": "<base64(ephemeralPubKey || nonce || ciphertext || signature)>"
}
```

The recipient field is NOT encrypted — the relay needs it for routing. The
payload contains everything else. The relay also stores `created_at` (UTC
ISO 8601) as insertion time.

### Plaintext message structure (before encryption)

```json
{
  "type": "message",
  "id": "<uuid>",
  "from": "<sender alias or pubkey>",
  "to": "<recipient alias or pubkey>",
  "subject": "<short subject>",
  "body": "<message contents>",
  "timestamp": "<UTC ISO 8601>",
  "in_reply_to": "<uuid | null>"
}
```

`in_reply_to` enables threading — a reply carries the UUID of the message
it responds to.

---

## 5. Relay Server API

### `POST /api/v1/send`

Store an encrypted message for a recipient.

**Request:**
```json
{
  "sender": "<base64 sender pubkey>",
  "recipient": "<base64 recipient pubkey>",
  "payload": "<base64 full encrypted blob>"
}
```

**Response (201):**
```json
{
  "id": "<uuid>",
  "status": "stored"
}
```

**Errors:**
- `400` — Missing or malformed fields
- `413` — Payload exceeds 1MB

### `GET /api/v1/poll?recipient=<base64>&since=<ISO8601>`

Retrieve all unread messages for a recipient.

| Param | Required | Description |
|-------|----------|-------------|
| `recipient` | Yes | Base64 public key of the recipient |
| `since` | No | Only return messages stored after this time (UTC ISO 8601). Useful for incremental polling. |

**Response (200):**
```json
{
  "messages": [
    {
      "id": "<uuid>",
      "sender": "<base64>",
      "recipient": "<base64>",
      "payload": "<base64>",
      "created_at": "<ISO 8601>"
    }
  ]
}
```

Messages are deleted from the relay after first successful poll return
(read-once delivery). If the poll succeeds (HTTP 200), the relay deletes
those messages. If the client crashes after receiving but before processing,
the message is lost — acceptable for a v0; the client can re-request a new
message from the sender.

The `since` parameter lets the client re-poll without receiving the same
messages twice if the relay deletion failed — the relay returns messages
with `created_at > since` (using an exclusion window of -30s to handle clock
skew).

### `GET /api/v1/health`

**Response (200):**
```json
{
  "status": "ok",
  "uptime": 123456,
  "message_count": 42
}
```

### Implementation notes

- **Storage:** SQLite with one table:
  ```sql
  CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    sender TEXT NOT NULL,
    recipient TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_recipient ON messages(recipient);
  CREATE INDEX idx_created ON messages(created_at);
  ```
- **Cleanup:** A background job runs every hour, deleting messages older than
  7 days. Also log the current message count for health reporting.
- **TTL headers:** All responses include `Cache-Control: no-store`.
- **Payload limit:** 1MB (reject with 413 if larger).

---

## 6. MCP Tools

The MCP server exposes three tools to the OpenCode agent:

### `send_message`

Send an encrypted message to another agent.

**Input:**
```json
{
  "peer": "vps-sysadmin",
  "subject": "fail2ban check results",
  "body": "Found 3 new banned IPs, reports sent to your inbox."
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `peer` | Yes | Peer alias (from `peers.json`) or base64 public key |
| `subject` | No | Short subject line (max 200 chars) |
| `body` | Yes | Message content (max 100KB) |

**Behavior:**
1. Look up peer alias in `peers.json` → get recipient public key
2. If not found by alias, treat `peer` as raw base64 public key
3. Generate UUID for message ID
4. Construct plaintext JSON
5. Encrypt plaintext with NaCl box (ephemeral key)
6. Sign ciphertext with sender's Ed25519 key
7. POST to relay `/api/v1/send`
8. Return the message UUID

**Output:**
```json
{
  "status": "sent",
  "message_id": "<uuid>"
}
```

### `check_inbox`

Poll the relay for new messages.

**Input:**
```json
{
  "mark_read": true
}
```

**Behavior:**
1. GET relay `/api/v1/poll?recipient=<senderPubKey>&since=<lastPollTime>`
2. For each message:
   a. Verify Ed25519 signature against sender's public key
   b. If sender pubkey is unknown (not in `peers.json`), it's a new peer
      attempting to pair — handle via pairing flow (see §7)
   c. Decrypt with NaCl box
   d. Parse plaintext JSON
3. Update `lastPollTime` to now
4. Return all decrypted messages

**Output:**
```json
{
  "messages": [
    {
      "id": "<uuid>",
      "from": "vps-sysadmin",
      "subject": "fail2ban check results",
      "body": "Found 3 new banned IPs, reports sent to your inbox.",
      "timestamp": "<ISO 8601>",
      "in_reply_to": null
    }
  ]
}
```

The orchestrator should call `check_inbox` at session start and present any
new messages to the user before proceeding with the user's task. During a
session, the orchestrator may also check inbox between task phases if idle.

### `agent_pair`

Initiate or confirm a pairing handshake with a peer.

**Input:**
```json
{
  "action": "initiate | confirm | list | remove",
  "peer_alias": "vps-sysadmin",
  "peer_fingerprint": "a3f1c8e92b47d012"
}
```

| Action | Description |
|--------|-------------|
| `initiate` | Generate a pairing request message encrypted with the recipient's public key. Returns the sender's fingerprint to share out-of-band. |
| `confirm` | Confirm a pairing by storing the peer's public key and alias in `peers.json`. Requires `peer_alias` and `peer_fingerprint`. The tool searches inbox for the pairing request, verifies the fingerprint matches, and saves the peer. |
| `list` | List all known peers (alias + truncated fingerprint) |
| `remove` | Remove a peer by alias |

**Pairing protocol:**

1. **A initiates:** `agent_pair action=initiate`
   - A outputs: "Share this fingerprint with your peer: `a3f1c8e92b47d012`"
   - A sends a signed, encrypted "pairing request" message to B's pubkey
     (which A must know — typed or QR-scanned) containing A's pubkey,
     alias, and fingerprint.

2. **B confirms:** `agent_pair action=confirm peer_alias=desktop-admin`
   - B polls inbox, finds the pairing request
   - B verifies that the fingerprint A sent matches what A claims
   - B stores `{ "<A's pubkey>": "desktop-admin" }` in `peers.json`
   - B sends a pairing acknowledgment back to A

3. **A confirms (optional):** A polls, finds the ack, stores B's key.

---

## 7. Session Integration (AGENTS.md)

Each agent that uses the relay should have this in its AGENTS.md or the
project's global AGENTS.md:

```markdown
## Agent Relay

This agent can communicate with peers via the agent-relay system.

- **MCP server:** `agent-relay-mcp` (in opencode.jsonc MCP config)
- **Agent ID:** `desktop-admin` (matches relay config)

### At session start

Call `check_inbox` before doing anything else. Present any unread messages
to the user and ask if they want to respond before proceeding with the
current task.

### During session

If the user asks to send a message to another agent, use `send_message`.
If they say "ask vps-sysadmin to do X", send a message and then call
`check_inbox` to wait for a response (poll every 15s with a 2-minute
timeout), showing each intermediate result to the user.

### Important

- Messages are read-once from the relay. If you crash after polling,
  the message is lost. The sender can resend if needed.
- Always check `lastPollTime` — pass `since` on every poll to avoid
  rereading already-processed messages.
- Never store plaintext messages in logs or memory longer than needed.
```

---

## 8. Configuration

### In `opencode.jsonc`

Each agent adds the MCP server to their config:

```jsonc
{
  "mcp": {
    "agent-relay": {
      "type": "local",
      "command": ["npx", "-y", "agent-relay-mcp"],
      "enabled": true,
      "environment": {
        "AGENT_RELAY_URL": "https://relay.splaq.us",
        "AGENT_RELAY_KEY": "optional-shared-secret",
        "AGENT_ID": "desktop-admin"
      }
    }
  }
}
```

| Env var | Required | Description |
|---------|----------|-------------|
| `AGENT_RELAY_URL` | Yes | Base URL of the relay server (no trailing slash) |
| `AGENT_RELAY_KEY` | No | Shared secret sent as `X-Relay-Key` header on all requests. If the relay has `RELAY_AUTH_KEY` set, it checks this header. If unset, no auth. |
| `AGENT_ID` | Yes | Human-readable alias for THIS agent — used in `peers.json` display and stored in agent config |

### Relay server env vars

| Env var | Default | Description |
|---------|---------|-------------|
| `PORT` | `3001` | HTTP listen port |
| `HOST` | `0.0.0.0` | Bind address |
| `DB_PATH` | `./relay.db` | SQLite database path |
| `RELAY_AUTH_KEY` | unset | If set, all requests must include `X-Relay-Key` header matching this value |
| `MESSAGE_TTL_DAYS` | `7` | Auto-delete messages older than this |
| `MAX_PAYLOAD_BYTES` | `1048576` | Max message size (1MB) |

---

## 9. Error Handling

### Crypto errors

| Situation | Behavior |
|-----------|----------|
| Signature verification fails | Drop message silently, log warning, continue polling |
| Decryption fails (wrong key, corrupted) | Drop message, log error, continue polling |
| Unknown sender pubkey | Store as "unverified" in inbox, display to user with note |
| Missing keypair file | Generate new keypair on first tool call |

### Relay errors

| HTTP Status | Client behavior |
|-------------|-----------------|
| `200` / `201` | Success — proceed |
| `400` | Log error, return to user — malformed request |
| `401` | Log error — relay auth key mismatch. Stop. |
| `413` | Log error — message too large. Split or abort. |
| `429` | Retry with exponential backoff (1s, 2s, 4s, max 30s) |
| `5xx` | Retry 3 times with 5s backoff, then fail open — return error to user |
| Timeout | Retry once after 10s, then fail open |

---

## 10. Deployment

### Option A: Standalone server

```bash
git clone <repo>/agent-relay
cd agent-relay/server
npm install
npm run build
RELAY_AUTH_KEY="s3cret" npm start
```

Behind Traefik/Caddy with TLS. Can run on the VPS or LAN server.

### Option B: Docker

```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY server/ .
RUN npm ci && npm run build
ENV PORT=3001
EXPOSE 3001
CMD ["node", "dist/index.js"]
```

### Option C: Serverless (not recommended)

The SQLite + polling model doesn't map cleanly to serverless (no persistent
filesystem, cold starts). Not recommended unless you swap SQLite for a hosted
DB.

---

## 11. Future (explicitly out of scope for v0)

- **WebSocket push** — instead of polling, the relay pushes new messages to
  connected clients. Eliminates polling latency.
- **Delivery receipts** — "read at <timestamp>" messages sent automatically.
- **Group messaging** — send to N recipients with one encrypt-per-recipient.
- **Attachments** — binary payloads alongside message body.
- **Replay / history** — keep messages longer than 7 days with opt-in.
- **End-to-end read receipts** — encrypted receipts so the relay can't track
  who read what.

---

## 12. Admin Panel (v0.2)

### Overview

An optional management layer for the relay operator. Disabled by default. When
`ADMIN_KEY` env var is set, the server enables:
- `GET /admin` — admin dashboard page
- `POST /api/v1/admin/*` — admin REST API
- Auto-migration of `RELAY_AUTH_KEYS` tenants to database on startup

The admin panel is an additive feature. All existing routes, auth, and MCP
client behavior are unchanged.

---

### 12.1 Configuration

| Env var | Default | Description |
|---|---|---|
| `ADMIN_KEY` | unset | Enables admin API. If unset, all admin routes return 404. |
| `ADMIN_MIGRATE` | `true` | Auto-migrate env var tenants to DB on first startup with `ADMIN_KEY`. |

---

### 12.2 Database Schema

New tables in addition to `messages`:

```sql
CREATE TABLE IF NOT EXISTS tenants (
  id           TEXT PRIMARY KEY,
  name         TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tenant_keys (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key_hash    TEXT NOT NULL,
  key_prefix  TEXT NOT NULL,
  is_active   INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  rotated_at  TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_key
  ON tenant_keys(tenant_id) WHERE is_active = 1;
CREATE INDEX IF NOT EXISTS idx_tenant_keys_lookup
  ON tenant_keys(key_hash);

CREATE TABLE IF NOT EXISTS agents (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  pubkey        TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at  TEXT,
  UNIQUE(tenant_id, pubkey)
);
CREATE INDEX IF NOT EXISTS idx_agents_tenant ON agents(tenant_id);
CREATE INDEX IF NOT EXISTS idx_agents_pubkey ON agents(pubkey);
```

### 12.2.1 Key Hashing

Keys are never stored as plaintext in the database. The hash is:

```
hash = SHA-256("agent-relay-key-v1:" + key)
```

`key_prefix` is the first 8 characters of the raw key, used for display in the
admin panel so operators can identify which key is active without seeing the
full secret.

---

### 12.3 Auth Model

#### 12.3.1 Admin Auth

Admin routes use a separate `X-Admin-Key` header checked against the `ADMIN_KEY`
env var. No hash, no DB lookup — direct string comparison.

If `ADMIN_KEY` is not configured, all admin routes return `404` **without**
revealing that the admin surface exists. The health endpoint and landing page
are unaffected.

#### 12.3.2 Tenant Auth (refactored)

The existing `X-Relay-Key` auth middleware is extended to check two sources:

1. **Env var map** (existing path) — direct comparison against `RELAY_AUTH_KEYS`
   or `RELAY_AUTH_KEY`. Fast path.
2. **DB auth cache** (new path) — if no env var match, hash the key and look up
   in the in-memory cache loaded from `tenant_keys` table.

If neither source matches, return 401. If no auth is configured at all (no env
vars, no DB keys), run in dev mode (allow all).

The auth cache is refreshed on startup and after any key create/rotate/delete
operation.

---

### 12.4 Admin API

All admin endpoints require `X-Admin-Key` header matching `ADMIN_KEY`. All
return `404` if `ADMIN_KEY` is not set.

#### 12.4.1 Auth Check

```
GET /api/v1/admin/check

Response 200: {
  "authenticated": true,
  "stats": {
    "tenants": 5,
    "agents": 12,
    "messages": 1042,
    "uptime": 123456
  }
}
```

#### 12.4.2 Tenant CRUD

```
GET /api/v1/admin/tenants

Response 200: {
  "tenants": [{
    "id": "uuid", "name": "team-alpha", "display_name": "Team Alpha",
    "key_prefix": "a1b2c3d4",
    "agent_count": 3, "message_count": 142,
    "created_at": "2026-01-15T..."
  }]
}

POST /api/v1/admin/tenants

Body: { "name": "team-alpha", "display_name": "Team Alpha" }

Response 201: {
  "id": "uuid", "name": "team-alpha", "display_name": "Team Alpha",
  "key": "generated-64-char-hex...",    // shown ONCE
  "key_prefix": "a1b2c3d4",
  "created_at": "2026-01-15T..."
}

Errors: 409 (name conflict)

PUT /api/v1/admin/tenants/:id

Body: { "display_name": "Updated Name" }
Response 200: { full tenant object }

DELETE /api/v1/admin/tenants/:id

Response 200: { "status": "deleted" }
```

#### 12.4.3 Key Rotation

```
POST /api/v1/admin/tenants/:id/rotate-key

Response 200: {
  "key": "new-64-char-hex...",      // shown ONCE
  "key_prefix": "xyz78901"
}

Behavior:
1. Mark current active key as inactive (set rotated_at)
2. Generate new key (crypto.randomBytes(32).toString('hex'))
3. Hash with domain prefix, insert into tenant_keys as active
4. Refresh in-memory auth cache
5. Return new key (only time it's visible)

GET /api/v1/admin/tenants/:id/keys

Response 200: {
  "keys": [{
    "id": "uuid",
    "key_prefix": "a1b2c3d4",
    "is_active": true,
    "created_at": "...",
    "rotated_at": null
  }]
}
Never returns full keys — only prefix and metadata.
```

#### 12.4.4 Agent Management

```
GET /api/v1/admin/tenants/:id/agents

Response 200: {
  "agents": [{
    "id": "uuid", "pubkey": "base64...",
    "display_name": "vps-sysadmin",
    "last_seen_at": "2026-01-15T...",
    "created_at": "2026-01-10T..."
  }]
}

POST /api/v1/admin/tenants/:id/agents

Body: { "pubkey": "base64...", "display_name": "vps-sysadmin" }
Response 201: { agent object }

Errors: 409 (pubkey already registered in this tenant)

PUT /api/v1/admin/tenants/:id/agents/:agentId
Body: { "display_name": "new-name" }
Response 200: { agent object }

DELETE /api/v1/admin/tenants/:id/agents/:agentId
Response 200: { "status": "deleted" }

GET /api/v1/admin/agents
Response 200: { "agents": [...] }  // all agents across all tenants, with tenant_name
```

#### 12.4.5 Stats

```
GET /api/v1/admin/stats

Response 200: {
  "tenant_count": 5, "agent_count": 12,
  "message_count": 1042, "uptime": 123456
}
```

#### 12.4.6 Migration

```
POST /api/v1/admin/migrate

Response 200: {
  "migrated": 3,
  "skipped": 1,
  "message": "Migrated 3 tenants from RELAY_AUTH_KEYS"
}

Behavior: reads env vars, creates tenant + key rows. Skips names that already
exist in DB. Idempotent.
```

---

### 12.5 Auto-Migration

On startup, if `ADMIN_KEY` is set and `ADMIN_MIGRATE` is not `false`:

1. Check if `tenants` table has any rows
2. If DB is empty AND `RELAY_AUTH_KEYS` (or `RELAY_AUTH_KEY`) has entries:
   - For each tenant in env var, insert DB row + hashed key
   - Log migration count
3. If DB already has tenants, skip (don't duplicate)

This ensures existing deployments get a seamless migration path. The env var
tenants continue to work during and after migration since both sources are
checked in the auth middleware.

---

### 12.6 Agent Registration

Agents work without registration — backward compat is a hard requirement.

When an agent IS registered, the relay updates `last_seen_at` in the agents
table on send/poll operations for matching pubkeys. This is a lightweight DB
write that piggybacks on existing request processing:

```
On POST /api/v1/send or GET /api/v1/poll:
  if res.locals.tenantId is set:
    store.updateAgentLastSeen(senderOrRecipientPubkey)
    // no-op if pubkey not registered, fast path if it is
```

The admin panel shows unregistered agents as "Unknown (pubkey truncated...)".

#### 12.6.1 Self-registration (future, not v1)

A future endpoint `POST /api/v1/register` would allow agents to self-register
using their tenant's `X-Relay-Key`. The relay resolves the key to a tenant and
creates an agent entry with the provided pubkey and display name. Not in scope
for v0.2.

---

### 12.7 Dashboard Page (`/admin`)

Single HTML page served from `server/public/admin.html`. Same design system as
the existing landing page (CSS variables: `--bg-0`, `--surface`, `--violet`,
`--cyan`, etc.).

**JS flow:**
1. On load, check `sessionStorage` for saved admin key
2. If missing, show a login overlay prompting for the admin key
3. Key is stored in `sessionStorage` (cleared on tab close)
4. All subsequent fetch() calls include `X-Admin-Key` header
5. Fetch `/api/v1/admin/check` — if 401, clear key, show login overlay again
6. Fetch and render: tenant table, agent table, stats cards
7. Mutations (create tenant, rotate key, delete agent) via fetch POST/PUT/DELETE
8. Client-side show/hide for forms and confirmation dialogs

**Layout:**
- Stats bar: tenant count, agent count, message count, uptime
- Tenant table with: name, key prefix, agents count, message count, created, actions (rotate key, delete, view agents)
- Create tenant form (inline or modal)
- Agent table with: display name, pubkey (truncated), tenant, last seen, actions (edit, delete)
- Global admin key prompt overlay on first load

---

### 12.8 In-Memory Auth Cache

```typescript
interface AuthCacheEntry {
  tenantId: string;
  tenantName: string;
  keyHash: string;
}

class AuthCache {
  private dbKeys: Map<string, AuthCacheEntry> = new Map();
  private envKeys: Map<string, string> = new Map();   // key → tenantName

  loadFromEnv(tenants: Record<string, string>): void;
  loadFromDb(store: MessageStore): void;
  lookup(key: string): { tenantId?: string; tenantName: string } | null;
  refreshDbKeys(store: MessageStore): void;
}
```

`refreshDbKeys()` is called:
- On startup
- After `POST /api/v1/admin/tenants/:id/rotate-key`
- After `POST /api/v1/admin/tenants` (new tenant = new key)
- After `DELETE /api/v1/admin/tenants/:id` (removes all tenant's keys)

This makes key changes effective immediately without a server restart.

---

### 12.9 Error Codes

| HTTP | Meaning | When |
|------|---------|------|
| `404` | Admin disabled | `ADMIN_KEY` not configured |
| `401` | Unauthorized | `X-Admin-Key` missing or wrong |
| `400` | Bad request | Missing or invalid body fields |
| `409` | Conflict | Tenant name or agent pubkey already exists |

---

### 12.10 File Changes

```
server/src/index.ts    — add admin routes + admin auth middleware
server/src/store.ts    — add tenant/key/agent CRUD + stats + auth cache queries
server/src/types.ts    — add admin API type definitions
server/src/auth.ts     — NEW: extracted auth cache + hash helpers
server/public/admin.html  — NEW: admin dashboard page
```

Admin routes are small enough (< 200 lines) to keep inline in `index.ts` behind
a feature flag check. If they grow significantly, extract to `server/src/admin.ts`.

---

### 12.11 Backward Compatibility Matrix

| Feature | Before v0.2 | After v0.2 |
|---|---|---|
| `POST /api/v1/send` | Auth via env var | Auth via env var + DB keys |
| `GET /api/v1/poll` | Same | Same |
| `GET /api/v1/health` | Public | Public — unchanged |
| `X-Relay-Key` header | Required if auth configured | Required if auth configured |
| `RELAY_AUTH_KEY` env var | Single tenant | Still works |
| `RELAY_AUTH_KEYS` env var | Multi-tenant JSON | Still works + auto-migration |
| MCP client | Sends `X-Relay-Key` | Unchanged — no client changes |
| Landing page `/` | Serves `index.html` | Unchanged |
