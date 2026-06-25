---
name: agent-relay
description: >
  End-to-end encrypted messaging between AI agents on different machines via
  the @splaq/agent-relay-mcp MCP server. Use when you need to send or receive
  encrypted messages to/from other agents (desktop, VPS, CI/CD, etc.).

  TRIGGER THIS SKILL WHEN:
  - Configuring the agent-relay MCP server in your agent's MCP config
  - Sending an encrypted message to another agent
  - Checking your inbox for messages from other agents
  - Pairing with a new peer agent for the first time
  - Managing peer list or troubleshooting message delivery
  - Setting up session-start inbox polling

  SYMPTOMS:
  - Agent doesn't know to call check_inbox at session start
  - Agent tries to send a message before pairing is complete
  - Agent doesn't know how to handle pairing request messages
  - Agent sends sensitive data over unencrypted channels when relay is available
  - Agent forgets to check inbox and misses cross-machine instructions
---

# Agent Relay — Encrypted Cross-Machine Messaging for Agents

Agent Relay lets AI agents on different machines send each other encrypted
messages through a self-hosted relay server. The relay never sees plaintext —
messages are NaCl-box encrypted with per-message ephemeral keys (PFS) and
Ed25519 signed.

## Architecture

```
┌─────────────┐     NaCl box     ┌──────────────┐     NaCl box     ┌─────────────┐
│ Desktop      │◄───encrypted───►│  Relay        │◄───encrypted───►│ VPS          │
│ agent-a      │    opaque blob  │  (untrusted)  │    opaque blob  │ agent-b      │
│ Ed25519 key  │                 │  SQLite       │                 │ Ed25519 key  │
└─────────────┘                 └──────────────┘                 └─────────────┘
```

## Available MCP Tools

| Tool | What it does | When to use |
|------|-------------|-------------|
| `check_inbox` | Poll relay for messages, auto-decrypt, handle pairing | At session start, between tasks, on demand |
| `send_message` | Encrypt + send to a peer | To push instructions, data, or notifications to another agent |
| `agent_pair` | Manage peer keys (initiate, confirm, list, remove) | First-time setup, adding new peers |

## Session Lifecycle

### At every session start

Call `check_inbox` **before anything else**. The relay is read-once — messages
are deleted after successful poll. If you don't check at start, you miss them.

```
check_inbox
# → { messages: [{ from: "vps", subject: "Update complete", body: "..." }] }
```

Present messages to the user immediately. Don't process them silently.

### During the session

- Send updates to peers when significant events happen
- Check inbox between long-running tasks
- Use `send_message` for cross-machine coordination (e.g., "deploy done, ready for testing")

### At session end (optional)

If the user asks you to notify another agent when you're done, send a summary.

## Pairing Walkthrough

Pairing is TOFU (Trust On First Use) — like SSH. Exchange fingerprints out-of-band.

**Step 1 — Initiator generates fingerprint:**
```
agent_pair action=initiate
# → Share this fingerprint with your peer: <16-char hex>
```

**Step 2 — Peer checks inbox (pairing request arrives as a message):**
```
check_inbox
```

**Step 3 — Peer confirms the pairing:**
```
agent_pair action=confirm peer_alias=desktop peer_fingerprint=<16-char hex>
```

**Step 4 — Done.** Both sides now have each other's public keys.

**To see known peers:**
```
agent_pair action=list
# → desktop              a3f1c8e92b47d012
# → vps-sysadmin         4c0cdf9a13da3477
```

**To remove a peer:**
```
agent_pair action=remove peer_alias=desktop
```

## Sending Messages

```
send_message peer=vps-sysadmin subject="fail2ban check" body="3 new banned IPs this hour"
# → { status: "sent", message_id: "<uuid>" }
```

The message is encrypted with your peer's public key + your signing key before
it leaves your machine. The relay stores an opaque blob.

## Receiving Messages

```
check_inbox
# → {
#   messages: [{
#     id: "<uuid>",
#     from: "desktop",
#     subject: "deploy ready",
#     body: "Prod deploy finished. Can you verify?",
#     timestamp: "2026-06-24T18:00:00Z"
#   }]
# }
```

Messages are **read-once** — successful poll deletes them from the relay. Senders
can resend if you miss one.

## Configuration

Add to your MCP config:

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

| Variable | Required | Description |
|----------|----------|-------------|
| `AGENT_RELAY_URL` | Yes | Relay server URL (no trailing slash) |
| `AGENT_RELAY_KEY` | No | Auth key matching the relay's config |
| `AGENT_ID` | Yes | Human-readable alias for this agent |

Keys auto-generate on first run at `~/.config/agent-relay/keypair.json`.

## Session Integration

Add this to your agent's instructions (AGENTS.md or CLAUDE.md):

```markdown
## Agent Relay — Cross-Machine Messaging

### At session start
Call `check_inbox` before anything else. Present messages to the user.

### During session
- Use `send_message` to send encrypted messages to peers
- Use `check_inbox` to poll for replies
- Messages are read-once — process them or they're gone
```

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| `check_inbox` returns empty but I know there are messages | Relay auth key mismatch | Verify `AGENT_RELAY_KEY` matches relay's config |
| `send_message` fails with "peer not found" | Peer not paired or fingerprint wrong | Run `agent_pair action=list` to verify, re-pair if needed |
| Pairing hangs / never completes | Both sides need to `check_inbox` after initiate | The initiator must also check inbox — the ack arrives as a message |
| "Relay returned 401" | `AGENT_RELAY_KEY` is wrong or missing | Check relay's `RELAY_AUTH_KEYS` / `RELAY_AUTH_KEY` env vars |
| Agent can't find the relay | URL wrong or relay down | Verify `AGENT_RELAY_URL` and that the relay is running |

## Security Notes

- The relay is **untrusted** — it sees encrypted blobs and routing info only
- Keys auto-generate on first use. Back up `~/.config/agent-relay/keypair.json`
  if you re-image the machine
- No delivery receipts in v0 — idempotent messages only (safe to resend)
- Messages auto-delete after 7 days (configurable on the relay)
- Fingerprints are 16 hex chars — truncation of sha256(pubkey). Good for
  out-of-band verification but collision-safe in practice
