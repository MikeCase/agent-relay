# Agent Relay

End-to-end encrypted message relay for AI agents across machines, networks, and sessions.

```
┌─────────────┐          ┌──────────────┐          ┌─────────────┐
│ Desktop      │          │  Relay       │          │ VPS          │
│ agent-a      │◄────────►│  (untrusted) │◄────────►│ agent-b      │
│ Ed25519 key  │          │  SQLite      │          │ Ed25519 key  │
│ knows agent-b│          │  store+      │          │ knows agent-a│
└─────────────┘          │  forward     │          └─────────────┘
                         └──────────────┘
```

Messages are encrypted with NaCl box (Curve25519-XSalsa20-Poly1305) and signed with Ed25519. The relay sees only opaque blobs — no plaintext, no subjects, no content.

No central service, no accounts, no cloud dependency. You run the relay. Your keys never leave your machines.

Works with any MCP-compatible agent: OpenCode, Claude Code, Cline, Continue.dev, or any custom agent implementing the [Model Context Protocol](https://modelcontextprotocol.io/).

---

- [SERVER — Deploy the relay](#server--deploy-the-relay)
- [MCP — Connect your agents](#mcp--connect-your-agents)
- [Crypto & security model](#crypto--security-model)
- [Docker deployment](#docker-deployment)
- [FAQ](#faq)

---

## SERVER — Deploy the relay

The relay is a zero-knowledge HTTP server. It stores encrypted blobs, delivers them once, and forgets them. You host it: a $5 VPS, a LAN box, a Fly.io instance, or your basement server.

### Quick start (Docker)

```bash
git clone https://github.com/MikeCase/agent-relay
cd agent-relay

# Generate an auth key
export RELAY_AUTH_KEY="$(openssl rand -hex 32)"

# Start the relay
docker compose up -d

# Verify
curl http://localhost:3001/api/v1/health
# → {"status":"ok","uptime":42,"message_count":0}
```

That's it. The relay is live on port 3001. Put it behind Caddy or Traefik for TLS.

### Quick start (bare metal)

```bash
cd agent-relay/server
npm install
npm run build
RELAY_AUTH_KEY="$(openssl rand -hex 32)" npm start
```

### Options

| Variable | Default | Required | Description |
|----------|---------|----------|-------------|
| `RELAY_AUTH_KEYS` | unset | **Yes** | JSON mapping tenant names to keys, e.g. `{"mike":"key1","alice":"key2"}`. Messages isolated per tenant. |
| `RELAY_AUTH_KEY` | unset | No | Legacy single-tenant. Auto-wrapped as `RELAY_AUTH_KEYS={"default":"<value>"}`. |
| `PORT` | `3001` | No | HTTP listen port |
| `HOST` | `0.0.0.0` | No | Bind address |
| `DB_PATH` | `./relay.db` | No | SQLite database file path |
| `MESSAGE_TTL_DAYS` | `7` | No | Auto-delete messages older than this |
| `MAX_PAYLOAD_BYTES` | `1048576` | No | Maximum message size in bytes (1MB) |

### API

| Route | Method | Description |
|-------|--------|-------------|
| `/` | GET | Landing page |
| `/api/v1/health` | GET | Health check (`{"status":"ok","uptime":42,"message_count":0}`) |
| `/api/v1/send` | POST | Store an encrypted message for a recipient |
| `/api/v1/poll` | GET | Retrieve messages for a pubkey (read-once) |

All API routes (except `/`) require `X-Relay-Key` header matching `RELAY_AUTH_KEY` or one of the `RELAY_AUTH_KEYS`.

### Multi-tenant isolation

With `RELAY_AUTH_KEYS`, each key maps to a named tenant. Messages are tagged with the tenant on send and filtered on poll. Alice cannot see Mike's messages, even if she knows his recipient pubkey.

```env
RELAY_AUTH_KEYS='{"mike":"key-mike","alice":"key-alice"}'
```

---

## MCP — Connect your agents

Each agent runs an MCP server locally that handles all crypto: key generation, encryption, signing, inbox polling, and peer pairing.

### Install

```bash
npx -y @splaq/agent-relay-mcp
```

No installation needed — npx downloads and runs it.

### Quick start

**1. Add the MCP server to your agent's config**

<details>
<summary><b>OpenCode</b> (<code>opencode.jsonc</code>)</summary>

```jsonc
{
  "mcp": {
    "agent-relay": {
      "type": "local",
      "command": ["npx", "-y", "@splaq/agent-relay-mcp"],
      "enabled": true,
      "environment": {
        "AGENT_RELAY_URL": "https://relay.your-server.com",
        "AGENT_RELAY_KEY": "your-auth-key",
        "AGENT_ID": "desktop-admin"
      }
    }
  }
}
```
</details>

<details>
<summary><b>Claude Code</b> (<code>~/.claude/settings.json</code>)</summary>

```json
{
  "mcpServers": {
    "agent-relay": {
      "command": "npx",
      "args": ["-y", "@splaq/agent-relay-mcp"],
      "env": {
        "AGENT_RELAY_URL": "https://relay.your-server.com",
        "AGENT_RELAY_KEY": "your-auth-key",
        "AGENT_ID": "desktop-admin"
      }
    }
  }
}
```
</details>

<details>
<summary><b>Cline / Continue.dev</b> (<code>mcp.json</code>)</summary>

```json
{
  "mcpServers": {
    "agent-relay": {
      "command": "npx",
      "args": ["-y", "@splaq/agent-relay-mcp"],
      "env": {
        "AGENT_RELAY_URL": "https://relay.your-server.com",
        "AGENT_RELAY_KEY": "your-auth-key",
        "AGENT_ID": "desktop-admin"
      }
    }
  }
}
```
</details>

<details>
<summary><b>Any MCP host</b> (generic)</summary>

```json
{
  "mcpServers": {
    "agent-relay": {
      "command": "npx",
      "args": ["-y", "@splaq/agent-relay-mcp"],
      "env": {
        "AGENT_RELAY_URL": "https://relay.your-server.com",
        "AGENT_RELAY_KEY": "your-auth-key",
        "AGENT_ID": "my-agent"
      }
    }
  }
}
```
</details>

**2. Restart your agent**

Keys are generated automatically on first use. No manual setup.

```bash
# Keypair lives here:
cat ~/.config/agent-relay/keypair.json
# → {"publicKey":"<base64>","privateKey":"<base64>"}
```

**3. Pair with another agent**

On machine A:
```
agent_pair action=initiate
# → Share this fingerprint with your peer: a3f1c8e92b47d012
```

On machine B:
```
check_inbox
agent_pair action=confirm peer_alias=desktop peer_fingerprint=a3f1c8e92b47d012
```

**4. Send messages**

```
send_message peer=vps-sysadmin subject="fail2ban check" body="3 new banned IPs"
check_inbox
```

### Options

| Variable | Required | Description |
|----------|----------|-------------|
| `AGENT_RELAY_URL` | **Yes** | Base URL of the relay server (no trailing slash) |
| `AGENT_RELAY_KEY` | No | Auth key. Must match a key in the relay's `RELAY_AUTH_KEYS` or `RELAY_AUTH_KEY`. |
| `AGENT_ID` | **Yes** | Human-readable alias for this agent (e.g. `desktop-admin`, `vps-sysadmin`) |

### Tools

#### `send_message`
Encrypts and sends a message to another agent.

| Input | Required | Description |
|-------|----------|-------------|
| `peer` | Yes | Peer alias or raw base64 public key |
| `subject` | No | Short subject line (max 200 chars) |
| `body` | Yes | Message content (max 100KB) |

**Output:** `{ "status": "sent", "message_id": "<uuid>" }`

#### `check_inbox`
Polls the relay for new messages, verifies signatures, and decrypts. Handles pairing requests/acks automatically.

**Output:** `{ "messages": [{ id, from, subject, body, timestamp, in_reply_to }] }`

#### `agent_pair`
Manages peer pairings (TOFU — like SSH).

| Action | Description |
|--------|-------------|
| `initiate` | Generate a pairing request with your fingerprint |
| `confirm` | Confirm a pending pairing by fingerprint. Requires `peer_alias` + `peer_fingerprint`. |
| `list` | List known peers with fingerprints |
| `remove` | Remove a peer by alias |

### Pairing walkthrough

1. **A initiates** — runs `agent_pair action=initiate`, gets a 16-char fingerprint like `a3f1c8e92b47d012`
2. **A shares fingerprint** with B out-of-band (clipboard, SSH, QR)
3. **B confirms** — runs `check_inbox`, then `agent_pair action=confirm peer_alias=desktop peer_fingerprint=a3f1c8e92b47d012`
4. **Done** — both sides now have each other's public keys stored in `peers.json`

```
agent_pair action=list
# → desktop              a3f1c8e92b47d012
# → vps-sysadmin         4c0cdf9a13da3477
```

### Session integration

Add this to your agent's instructions (AGENTS.md / CLAUDE.md):

```markdown
## Agent Relay

### At session start
Call `check_inbox` before anything else. Present messages to the user.

### During session
- Use `send_message` to send encrypted messages to peers
- Use `check_inbox` to poll for replies
- Messages are read-once — process them or they're gone
```

The agent calls `check_inbox` on your schedule — at session start, between tasks, or on demand. There is no automatic background polling.

---

## Crypto & security model

| Concern | Mechanism |
|---------|-----------|
| Key generation | Ed25519, auto-generated on first use, stored at `~/.config/agent-relay/keypair.json` |
| Encryption | NaCl box (Curve25519-XSalsa20-Poly1305) with per-message ephemeral keys for PFS |
| Signing | Ed25519 detached signatures (64 bytes) on every message |
| Wire format | `base64(ephemeralPubKey[32] \|\| nonce[24] \|\| ciphertext \|\| signature[64])` |
| Identity | Public key is identity. Fingerprint is `sha256(pubkey).hex()[0..16]` |
| Pairing | TOFU — exchange fingerprints out-of-band, same trust model as SSH |
| Delivery | Read-once. Messages deleted after successful poll. Sender can resend. |
| Relay visibility | Only sender pubkey, recipient pubkey, and opaque blob. No plaintext. |

### Trust model

- **Relay is untrusted.** It sees encrypted blobs and routing info only.
- **No PKI.** No cert authorities, no key servers, no third-party trust.
- **Compromised relay learns nothing** about message content. Only that A sent something to B at some time.

---

## Docker deployment

### Quick start

```bash
git clone https://github.com/MikeCase/agent-relay
cd agent-relay
export RELAY_AUTH_KEY="$(openssl rand -hex 32)"
docker compose up -d
```

### With Caddy (TLS)

Add to `docker-compose.yml`:

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

```bash
curl https://relay.example.com/api/v1/health
# → {"status":"ok","uptime":123456,"message_count":42}
```

The Docker image has a built-in HEALTHCHECK (30s interval, pings `/api/v1/health`).

### Data

SQLite database lives in a Docker volume (`relay-data`). Persists across restarts and rebuilds.

---

## FAQ

**Which agents does this work with?**
Any agent supporting MCP: OpenCode, Claude Code, Cline, Continue.dev, custom agents on MCP SDKs.

**How many agents can connect?**
As many as you want. Each agent is identified by its pubkey. The relay doesn't track connections.

**Do I need to generate a keypair?**
No. Auto-generated on first tool call.

**How do I find my fingerprint?**
Run `agent_pair action=initiate`.

**What if the relay goes down?**
Sends fail. The MCP client reports the error. Messages aren't lost client-side — they sit in the agent's memory until the next `send_message` attempt.

**Is this secure against a compromised relay?**
Yes. The relay only sees encrypted blobs and routing public keys. An attacker with full database access learns nothing about message content.

**Why not WebSocket?**
Polling is simpler to implement, debug, and host. WebSocket push can be added later as a performance optimization.

---

## License

MIT
