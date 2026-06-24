# Agent Relay — Plan

## What

A lightweight message relay that lets two (or N) OpenCode agents talk to each
other across machines, networks, and sessions. Each agent has an Ed25519 keypair.
Messages are end-to-end encrypted. The relay is untrusted — it only stores and
forwards encrypted blobs.

## Why

Currently, two OpenCode agents on different machines (e.g., this desktop and the
VPS) can only communicate through janky out-of-band channels — email, shared
files, or me copy-pasting. That's slow, fragile, and pollutes my inbox.

A native relay gives agents a persistent mailbox they can check at session start
and dispatch to mid-session. I can float between terminals, tell each agent what
the other is doing, and keep the conversation on track without babysitting the
transport.

## Architecture

```
┌────────────┐         ┌──────────────┐         ┌────────────┐
│ Agent A    │         │   Relay      │         │ Agent B    │
│ pub: AAAA  │         │  (untrusted) │         │ pub: BBBB  │
│ priv: aaaa │         │              │         │ priv: bbbb │
│ knows BBBB │         │  SQLite      │         │ knows AAAA │
└─────┬──────┘         │  store+      │         └─────┬──────┘
      │                │  forward     │               │
      │  encrypt(msg,  │              │               │
      │    ephem_key,  │              │               │
      │    BBBB)       │              │               │
      │  sign(ctxt,    │              │               │
      │    aaaa)       │              │               │
      │────────────────→              │               │
      │  POST /send    │  store it    │               │
      │  {to, blob}    │              │               │
      │                │              │               │
      │                │              │   GET /poll   │
      │                │              │←──────────────│
      │                │              │   {blobs}     │
      │                │              │──────────────→│
      │                │              │               │ verify(blob, AAAA)
      │                │              │               │ decrypt(blob, bbbb)
```

## Trust model

The relay sees nothing but opaque blobs and routing metadata (sender pub key +
recipient id). No message content, no subjects, no timing analysis beyond "A sent
something to B at time T." Pairing is TOFU (Trust On First Use) — exchange public
key fingerprints out-of-band (QR, clipboard, typed hash), same as SSH.

## Trade-offs

| Choice | Why |
|--------|-----|
| **NaCl box** (curve25519-xsalsa20-poly1305) over raw RSA or AES | Authenticated encryption + perfect forward secrecy via ephemeral keys. libsodium bindings exist in every language. |
| **Store-and-forward polling** over WebSocket | Simpler to implement, debug, and host. Agents already poll at session start. Real-time push is a future optimization. |
| **Single-file SQLite** over Postgres | The relay has zero schema complexity. SQLite is one file, no daemon, fits on a $5 VPS. |
| **No delivery receipts** | Keep it simple. Messages are idempotent — re-polling is safe. Read-receipts can be added later as ordinary messages. |
| **Ed25519** over ECDSA | Smaller keys, faster signing, simpler API, same security level. Used by WireGuard, OpenSSH, Tor. |

## Use cases

- **Cross-machine coordination:** "VPS agent, check fail2ban and report back"
- **Task handoff:** "Desktop agent, I investigated these IPs — here's the context"
- **Status sharing:** "Still running, 3 of 5 phases complete, waiting on oracle"
- **Session continuity:** Pick up a conversation from a different terminal

## Non-goals

- Real-time streaming / live chat between agents (WebSocket can be added later)
- Group chat / broadcast (not needed for 2–3 agents)
- Message persistence beyond TTL (old messages are deleted after 7 days)
- ACLs or user management (pubkey is identity)
- Relaying through Tor / onion services (unnecessary complexity for now)

---

## Admin Panel (v0.2)

### What

A management layer for the relay operator: create and manage tenants, register
agents, rotate auth keys, view stats. Served as a password-locked dashboard at
`/admin` and a REST API at `/api/v1/admin/*`.

### Why

The relay currently has no visibility and no management surface. Tenants are
static env vars (`RELAY_AUTH_KEYS`). There's no way to:
- See how many messages each tenant has sent
- Register agents with display names
- Rotate a tenant's auth key without restarting the server
- Know when an agent last checked in

Adding an admin panel turns the relay from a fire-and-forget blob store into
something you can operate day-to-day.

### Auth model

| Auth header | Purpose | Backed by | Routes |
|---|---|---|---|
| `X-Relay-Key` | Tenant auth (existing) | Env vars + DB `tenant_keys` table | `/api/v1/send`, `/api/v1/poll` |
| `X-Admin-Key` | Admin auth (new) | `ADMIN_KEY` env var | `/api/v1/admin/*`, `/admin` |

The admin key is an env var because of the bootstrap problem — you need
something to authenticate the first admin operation. The admin key never goes
through the hash-based DB path; it's a direct comparison.

If `ADMIN_KEY` is not set, all admin routes return `404` (not `401`) to avoid
advertising the admin surface.

### Data model

Three new tables beyond the existing `messages` table:

- **tenants** — name, display name, timestamps
- **tenant_keys** — hashed keys, one active per tenant (enforced by partial unique index)
- **agents** — registered pubkeys under a tenant with display name and last-seen

The existing `messages.tenant` TEXT column bridges to the new `tenants.name`
column for stats queries.

### Agent registration

Agents work without registration (backward compat). Registration is optional and
admin-driven — the admin registers an agent's pubkey and display name via the
dashboard. The relay updates `last_seen_at` on send/poll for registered pubkeys.
Unregistered agents continue to work; they show as "Unknown" in the admin panel.

### Migration

Existing `RELAY_AUTH_KEYS` env var tenants are auto-migrated to DB on first
startup with `ADMIN_KEY` set. Both env var and DB auth sources coexist in the
middleware. No forced migration — the old path works forever.

### Key rotation

When a tenant key is rotated via the admin API, the old key is marked inactive
(with a `rotated_at` timestamp) and a new hashed key is inserted. The in-memory
auth cache is refreshed immediately — no restart needed. The new key is shown
once in the API response; old keys remain visible as metadata (prefix, dates),
never as plaintext.

### Server-side state

This shift introduces real persistent state (tenants, keys, agents) beyond the
existing message blobs. The server now caches auth data in memory and refreshes
it from the DB on key mutations. Not stateless anymore, but the state is
single-box and in-process.

### Non-goals

- OIDC / SSO for the admin panel (v0.2 milestone)
- Agent self-registration (agents register via admin only in v1)
- Per-agent rate limiting (configurable via env var TTL/payload limits only)
- WebSocket push for admin real-time updates
