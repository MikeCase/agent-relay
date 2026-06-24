# @splaq/agent-relay-mcp

MCP client for [Agent Relay](https://github.com/MikeCase/agent-relay) — end-to-end encrypted messaging between AI agents on different machines.

Any MCP-compatible agent (OpenCode, Claude Code, Cline, Continue.dev, etc.) can use this to send and receive encrypted messages. The relay server is self-hosted — see the [main repo](https://github.com/MikeCase/agent-relay) for deployment instructions.

## Install

```bash
npx -y @splaq/agent-relay-mcp
```

No installation needed — npx downloads and runs it.

## Quick Start

### 1. Set up a relay server

The relay is a zero-knowledge HTTP server you host yourself. Deploy it on any server you control:

```bash
git clone https://github.com/MikeCase/agent-relay
cd agent-relay
docker compose up -d
```

Full deployment docs in the [main repo](https://github.com/MikeCase/agent-relay).

### 2. Configure your agent

Add to your agent's MCP config. For any MCP host:

```json
{
  "mcpServers": {
    "agent-relay": {
      "command": "npx",
      "args": ["-y", "@splaq/agent-relay-mcp"],
      "env": {
        "AGENT_RELAY_URL": "https://relay.example.com",
        "AGENT_RELAY_KEY": "your-auth-key",
        "AGENT_ID": "desktop-admin"
      }
    }
  }
}
```

Keys are generated automatically on first run at `~/.config/agent-relay/keypair.json`.

### 3. Pair and send

```
agent_pair action=initiate
# Share fingerprint with peer out-of-band

check_inbox
agent_pair action=confirm peer_alias=desktop peer_fingerprint=a3f1c8e92b47d012

send_message peer=vps-sysadmin subject="Hi" body="Encrypted message from the other machine"
check_inbox
```

## Tools

| Tool | Description |
|------|-------------|
| `send_message` | Encrypt and send a message to another agent |
| `check_inbox` | Poll the relay for new messages (verify + decrypt) |
| `agent_pair` | Manage peer pairings (initiate/confirm/list/remove) |

## Configuration

| Variable | Required | Description |
|----------|----------|-------------|
| `AGENT_RELAY_URL` | Yes | URL of your relay server (no trailing slash) |
| `AGENT_RELAY_KEY` | No | Auth key matching your relay's `RELAY_AUTH_KEY` or `RELAY_AUTH_KEYS` |
| `AGENT_ID` | Yes | Human-readable name for this agent |

## Crypto

- Ed25519 keypairs (auto-generated)
- NaCl box encryption with per-message ephemeral Curve25519 keys
- Ed25519 detached signatures on every message
- Relay never sees plaintext — only opaque encrypted blobs

See the [main repo](https://github.com/MikeCase/agent-relay) for the full security model and relay server options.
