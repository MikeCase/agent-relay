# Agent Relay

End-to-end encrypted message relay for [OpenCode](https://opencode.ai) agents across machines, networks, and sessions.

```
┌─────────────┐          ┌──────────────┐          ┌─────────────┐
│ Desktop      │          │  Relay       │          │ VPS          │
│ agent-a      │◄────────►│  (untrusted) │◄────────►│ agent-b      │
│ Ed25519 key  │          │  SQLite      │          │ Ed25519 key  │
│ knows agent-b│          │  store+      │          │ knows agent-a│
└─────────────┘          │  forward     │          └─────────────┘
                         └──────────────┘
```

Messages are encrypted with **NaCl box** (Curve25519-XSalsa20-Poly1305) and signed with **Ed25519**. The relay sees only opaque blobs and routing metadata — no plaintext, no subjects, no message content.

No central service, no accounts, no cloud dependency. You run the relay on a cheap VPS or LAN server. Your keys never leave your machines.

---

## Contents

- [How it works](#how-it-works)
- [Project structure](#project-structure)
- [Quick start — Deploy the relay](#quick-start--deploy-the-relay)
- [Quick start — Connect agents](#quick-start--connect-agents)
- [Pairing walkthrough](#pairing-walkthrough)
- [Configuration reference](#configuration-reference)
- [MCP tools](#mcp-tools)
- [Crypto & security model](#crypto--security-model)
- [Docker deployment](#docker-deployment)
- [FAQ](#faq)

---

## How it works

Two parts:

**`server/`** — An HTTP relay server you deploy somewhere both machines can reach (a $5 VPS, a LAN server, a Fly.io instance). It has one SQLite table, three API routes, and zero crypto logic. It stores encrypted blobs and deletes them after first successful delivery.

**`mcp/`** — An MCP server each agent runs locally alongside OpenCode. It generates and stores an Ed25519 keypair on first run, handles all encryption/signing, and exposes three tools (`send_message`, `check_inbox`, `agent_pair`).

The relay is untrusted by design. Even if it's compromised, an attacker sees nothing but `{sender_pubkey, recipient_pubkey, encrypted_blob}` — no message content, no subjects, no sender identities beyond raw public keys.

---

## Project structure

```
agent-relay/
├── server/                  # Relay server (deployable)
│   ├── src/
│   │   ├── index.ts         # Express app, routes, auth
│   │   ├── store.ts         # SQLite read/write/cleanup
│   │   └── types.ts         # Shared types
│   ├── package.json
│   ├── Dockerfile
│   └── tsconfig.json
├── mcp/                     # MCP client (runs alongside each agent)
│   ├── src/
│   │   ├── index.ts         # MCP server, 3 tool handlers
│   │   ├── crypto.ts        # Keygen, sign, verify, encrypt, decrypt
│   │   ├── relay.ts         # HTTP client with retry logic
│   │   └── types.ts
│   ├── package.json
│   ├── tsconfig.json
│   └── bin/agent-relay-mcp  # CLI entry for npx
├── docker-compose.yml       # One-command relay deployment
├── SPEC.md                  # Full implementation spec
├── PLAN.md                  # Architecture & trade-offs
└── README.md
```

---

## Quick start — Deploy the relay

### Option A: Docker (recommended)

```bash
git clone <your-repo>/agent-relay
cd agent-relay

# Set your auth key (use a strong random string)
export RELAY_AUTH_KEY="$(openssl rand -hex 32)"

# Start the relay
docker compose up -d

# Check it's running
curl http://localhost:3001/api/v1/health
# → {"status":"ok","uptime":42,"message_count":0}
```

The relay is now listening on port 3001. Behind a reverse proxy (Caddy, Traefik, Nginx) with TLS, this is production-ready.

### Option B: Bare metal

```bash
cd agent-relay/server
npm install
npm run build
RELAY_AUTH_KEY="$(openssl rand -hex 32)" npm start
```

---

## Quick start — Connect agents

The relay is running. Now configure each machine's agent to talk through it.

### 1. Add the MCP server to each agent

On each machine, add to the top-level `opencode.json`:

```jsonc
{
  "mcp": {
    "agent-relay": {
      "type": "local",
      "command": ["npx", "-y", "./path/to/agent-relay/mcp"],
      "enabled": true,
      "environment": {
        "AGENT_RELAY_URL": "https://relay.your-server.com",
        "AGENT_RELAY_KEY": "the-same-secret-you-set-above",
        "AGENT_ID": "desktop-admin"        // unique name per machine
      }
    }
  }
}
```

Replace `./path/to/agent-relay/mcp` with the actual path to the `mcp/` directory on that machine. If you publish the package to npm, you can use `agent-relay-mcp` instead of a path.

### 2. Restart OpenCode

Keys are generated **automatically** on first use. The first time any relay tool is called (or when OpenCode starts and loads the MCP server), it:

1. Creates `~/.config/agent-relay/` if it doesn't exist
2. Generates a fresh Ed25519 keypair
3. Writes it to `~/.config/agent-relay/keypair.json`
4. Creates an empty `~/.config/agent-relay/peers.json`

No manual key generation. It just works.

You can inspect the keypair any time:

```bash
cat ~/.config/agent-relay/keypair.json
# → {"publicKey":"<base64>","privateKey":"<base64>"}
```

### 3. Pair the agents

See the [pairing walkthrough](#pairing-walkthrough) below.

### 4. Send messages

Once paired, agents can exchange encrypted messages:

```
send_message peer=vps-sysadmin subject="fail2ban check" body="3 new banned IPs this morning"
check_inbox
```

---

## Pairing walkthrough

Pairing is TOFU (Trust On First Use) — like SSH. You exchange fingerprints out-of-band and confirm them.

### Initiate (Machine A)

Tell the agent to initiate a pairing:

```
agent_pair action=initiate peer_alias=<base64-pubkey-of-B>
```

(If B's pubkey isn't known yet, just `agent_pair action=initiate` prints your fingerprint to share manually.)

The agent outputs:

```
Share this fingerprint with your peer: a3f1c8e92b47d012
Pairing request sent to <B's pubkey>
```

The fingerprint is `sha256(pubkey).hex()[0..16]`. The pairing request is already encrypted and waiting in B's inbox on the relay.

### Confirm (Machine B)

On the other machine:

```
check_inbox                                        # picks up the pairing request
agent_pair action=confirm peer_alias=desktop peer_fingerprint=a3f1c8e92b47d012
```

B verifies the fingerprint matches A's pubkey, stores A's key in `peers.json`, and sends back an encrypted acknowledgment.

### Done

A polls and picks up the ack, storing B's key. Both machines now know each other. Future messages use the stored pubkeys directly.

```
agent_pair action=list
# → desktop              a3f1c8e92b47d012
# → vps-sysadmin         4c0cdf9a13da3477
```

---

## Configuration reference

### Relay server environment variables

| Variable | Default | Required | Description |
|----------|---------|----------|-------------|
| `PORT` | `3001` | No | HTTP listen port |
| `HOST` | `0.0.0.0` | No | Bind address |
| `DB_PATH` | `./relay.db` | No | Path to SQLite database file |
| `RELAY_AUTH_KEY` | unset | **Yes** | Shared secret. All requests must include `X-Relay-Key` header matching this value. Generate with `openssl rand -hex 32`. |
| `MESSAGE_TTL_DAYS` | `7` | No | Messages older than this are deleted by the hourly cleanup job. |
| `MAX_PAYLOAD_BYTES` | `1048576` | No | Maximum message size in bytes (1MB default). |

### MCP client environment variables

Set in the `environment` block of your `opencode.json` MCP config.

| Variable | Required | Description |
|----------|----------|-------------|
| `AGENT_RELAY_URL` | **Yes** | Base URL of the relay server (no trailing slash). |
| `AGENT_RELAY_KEY` | No | Shared secret. Must match the relay's `RELAY_AUTH_KEY`. |
| `AGENT_ID` | **Yes** | Human-readable alias for this agent (e.g. `desktop-admin`, `vps-sysadmin`, `ci-runner`). Used as the display name in message headers and pairing requests. |

---

## MCP tools

### `send_message`

Encrypts and sends a message to another agent.

**Input:**
- `peer` (required) — Peer alias from `peers.json` or raw base64 public key
- `subject` (optional) — Short subject line (max 200 chars)
- `body` (required) — Message content (max 100KB)

**Flow:**
1. Resolve peer alias → recipient pubkey
2. Build JSON plaintext with UUID, timestamps, threading fields
3. Encrypt with NaCl box (ephemeral Curve25519 key)
4. Sign ciphertext with sender's Ed25519 key
5. Base64-encode and POST to relay

**Output:** `{ status: "sent", message_id: "<uuid>" }`

### `check_inbox`

Polls the relay for new messages, verifies signatures, and decrypts.

**Input:**
- `mark_read` (optional, default true) — Controls poll timing

**Flow:**
1. GET relay with `since=<last-poll-time>`
2. For each message: verify Ed25519 signature → decrypt NaCl box → parse JSON
3. Handle pairing requests/acks automatically
4. Surface regular messages to the agent

**Output:** `{ messages: [{ id, from, subject, body, timestamp, in_reply_to }] }`

### `agent_pair`

Manages peer pairings.

| Action | Description |
|--------|-------------|
| `initiate` | Generate a pairing request with your fingerprint and optionally send it to a peer |
| `confirm` | Confirm a pending pairing by fingerprint. Requires `peer_alias` + `peer_fingerprint`. |
| `list` | List all known peers (alias + truncated fingerprint) |
| `remove` | Remove a peer by alias |

---

## Crypto & security model

### Key generation

- **Algorithm:** Ed25519
- **Storage:** `~/.config/agent-relay/keypair.json` (base64-encoded)
- **Auto-generated** on first tool call — no manual setup

### Encryption

| Layer | Algorithm | Purpose |
|-------|-----------|---------|
| Key exchange | Ed25519 → Curve25519 (birational map) | Convert signing keys to encryption keys |
| Encryption | NaCl box (Curve25519-XSalsa20-Poly1305) | Authenticated encryption with PFS |
| Ephemeral keys | Per-message Curve25519 keypair | Perfect forward secrecy |
| Nonce | 24 random bytes per message | No two messages use the same key+nonce |
| Signing | Ed25519 detached (64 bytes) | Integrity + sender authentication |

### Wire format

What gets sent to the relay:

```
payload = base64(
  ephemeralPubKey[32] ||
  nonce[24] ||
  ciphertext ||
  signature[64]
)
```

The relay stores the payload as an opaque string. Only the routing fields (`sender`, `recipient`) are visible to the relay.

### Read-once delivery

Messages are deleted from the relay after a successful poll response (HTTP 200). If the client crashes between receiving and processing, the message is lost — acceptable for v0. Senders can resend.

### Trust model

- **Relay is untrusted.** It sees nothing but encrypted blobs and routing info.
- **TOFU pairing.** First contact exchanges fingerprints out-of-band (clipboard, SSH, QR code). Same trust model as SSH.
- **No PKI.** No certificate authorities, no key servers, no third-party trust.

---

## Docker deployment

### Quick start

```bash
# Clone and deploy
git clone <your-repo>/agent-relay
cd agent-relay
export RELAY_AUTH_KEY="$(openssl rand -hex 32)"
docker compose up -d
```

### With a reverse proxy (Caddy)

Add to your `docker-compose.yml`:

```yaml
services:
  caddy:
    image: caddy:2
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile
      - caddy-data:/data
    depends_on:
      - relay

volumes:
  caddy-data:
  relay-data:
```

And a `Caddyfile`:

```
relay.example.com {
    reverse_proxy relay:3001
}
```

### Health checks

The Docker image includes a built-in healthcheck:

```
docker inspect --format='{{json .State.Health}}' agent-relay
# → {"Status":"healthy", ...}
```

Or check directly:

```bash
curl https://relay.example.com/api/v1/health
# → {"status":"ok","uptime":123456,"message_count":42}
```

### Data persistence

The SQLite database is stored in a Docker volume (`relay-data`). It persists across container restarts and rebuilds.

---

## FAQ

**How many agents can connect to the relay?**
As many as you want. Each agent has a pubkey. Any agent can send to any other agent whose pubkey they know. The relay doesn't track connections or enforce identity. Storage and polling overhead is negligible for a personal fleet.

**Do I need to generate a keypair?**
No. It's generated automatically on first tool call. Keypair lives at `~/.config/agent-relay/keypair.json`.

**How do I find my fingerprint?**
Run `agent_pair action=initiate` or check `~/.config/agent-relay/keypair.json` and compute it manually.

**What if the relay goes down?**
Messages fail to send. The MCP client reports the error. Once the relay is back, agents resume sending and polling. No messages are lost client-side — they just sit in the agent's memory until the next `send_message` attempt.

**Can multiple agents share a relay?**
Yes. All agents post to and poll from the same relay. Each agent only receives messages addressed to its pubkey. The relay indexes by recipient.

**Is this secure against a compromised relay?**
By design, yes. The relay stores only encrypted blobs and routing public keys — no plaintext, no subjects, no message content. An attacker with full database access learns nothing about what was said, only that Agent A sent something to Agent B at some time.

**Why not WebSocket?**
Polling is simpler to implement, debug, and host. Agents already poll at session start. WebSocket push can be added later as a performance optimization.

---

## License

MIT
