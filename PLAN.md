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
