import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { v4 as uuidv4 } from "uuid";
import util from "tweetnacl-util";

import { generateKeyPair, sign, verify, encrypt, decrypt, fingerprint } from "./crypto.js";
import { RelayClient } from "./relay.js";
import type {
  KeyPair,
  PeersFile,
  MessagePayload,
  AgentPairInput,
  SendMessageInput,
  CheckInboxInput,
} from "./types.js";

// ---- Config directory ----

const CONFIG_DIR = path.join(
  process.env.HOME || process.env.USERPROFILE || "~",
  ".config",
  "agent-relay",
);
const KEYPAIR_PATH = path.join(CONFIG_DIR, "keypair.json");
const PEERS_PATH = path.join(CONFIG_DIR, "peers.json");

// ---- Module-level state ----

let lastPollTime: string | null = null;

interface PendingPairing {
  senderPubKey: string;
  senderAlias: string;
  fingerprint: string;
  messageId: string;
}
const pendingPairings: PendingPairing[] = [];
const pendingOutboundPairings = new Set<string>(); // pubkeys we've sent pairing requests to

/** Dedup — track processed message IDs to prevent replay attacks */
const MAX_SEEN_IDS = 10000;
const seenMessageIds = new Set<string>();
function trackMessageId(id: string): void {
  if (seenMessageIds.size >= MAX_SEEN_IDS) {
    seenMessageIds.clear();
  }
  seenMessageIds.add(id);
}

// ---- Config I/O ----

function ensureConfigDir(): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

function loadKeyPair(): KeyPair {
  ensureConfigDir();
  if (fs.existsSync(KEYPAIR_PATH)) {
    const raw = fs.readFileSync(KEYPAIR_PATH, "utf-8");
    return JSON.parse(raw) as KeyPair;
  }

  // Generate new keypair on first run
  const kp = generateKeyPair();
  fs.writeFileSync(KEYPAIR_PATH, JSON.stringify(kp, null, 2), "utf-8");
  return kp;
}

function loadPeers(): PeersFile {
  if (fs.existsSync(PEERS_PATH)) {
    const raw = fs.readFileSync(PEERS_PATH, "utf-8");
    return JSON.parse(raw) as PeersFile;
  }
  return { peers: {} };
}

function savePeers(peers: PeersFile): void {
  ensureConfigDir();
  fs.writeFileSync(PEERS_PATH, JSON.stringify(peers, null, 2), "utf-8");
}

function formatPeerList(peers: PeersFile): string {
  const entries = Object.entries(peers.peers);
  if (entries.length === 0) return "No peers configured.";

  return entries
    .map(([pubkey, alias]) => {
      const fp = fingerprint(pubkey);
      return `  ${alias.padEnd(20)} ${fp}`;
    })
    .join("\n");
}

/** Resolve a peer alias or raw pubkey to a base64 public key. */
function resolvePeer(
  peer: string,
  peers: PeersFile,
): string | null {
  // Try alias lookup first
  for (const [pubkey, alias] of Object.entries(peers.peers)) {
    if (alias === peer) return pubkey;
  }
  // Treat as raw base64 pubkey
  try {
    util.decodeBase64(peer);
    return peer;
  } catch {
    return null;
  }
}

// ---- Environment ----

const RELAY_URL = process.env.AGENT_RELAY_URL;
const RELAY_KEY = process.env.AGENT_RELAY_KEY;
const AGENT_ID = process.env.AGENT_ID;

if (!RELAY_URL) {
  throw new Error("AGENT_RELAY_URL environment variable is required");
}
if (!AGENT_ID) {
  throw new Error("AGENT_ID environment variable is required");
}

// Narrowed alias — AGENT_ID is string after the guard above
const agentId: string = AGENT_ID;

const relayClient = new RelayClient({
  relayUrl: RELAY_URL,
  relayAuthKey: RELAY_KEY || undefined,
});

// ---- MCP Server ----

const server = new Server(
  {
    name: "agent-relay-mcp",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

// ---- Tool definitions ----

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "send_message",
        description:
          "Send an encrypted message to another agent via the relay. " +
          "The peer can be an alias from your peers list or a raw base64 public key.",
        inputSchema: {
          type: "object",
          properties: {
            peer: {
              type: "string",
              description: "Peer alias (from peers list) or base64 public key",
            },
            subject: {
              type: "string",
              description: "Short subject line (max 200 chars)",
            },
            body: {
              type: "string",
              description: "Message content (max 100KB)",
            },
          },
          required: ["peer", "body"],
        },
      },
      {
        name: "check_inbox",
        description:
          "Poll the relay for new encrypted messages. Decrypts and verifies " +
          "each message, handling pairing requests automatically.",
        inputSchema: {
          type: "object",
          properties: {
            mark_read: {
              type: "boolean",
              description: "Mark messages as read (default: true)",
            },
          },
        },
      },
      {
        name: "agent_pair",
        description:
          "Manage peer pairings. Initiate a pairing (outputs your fingerprint " +
          "to share out-of-band), confirm a pending pairing, list paired peers, " +
          "or remove a peer.",
        inputSchema: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: ["initiate", "confirm", "list", "remove"],
              description:
                "initiate: output your fingerprint (optionally send pairing request if peer_alias is a known pubkey). " +
                "confirm: confirm a pending pairing by fingerprint. " +
                "list: list all paired peers. " +
                "remove: remove a peer by alias.",
            },
            peer_alias: {
              type: "string",
              description:
                "Alias for the peer (used with confirm/remove). " +
                "For initiate, can be the recipient's base64 public key to send a pairing request.",
            },
            peer_fingerprint: {
              type: "string",
              description:
                "Peer's public key fingerprint (used with confirm). " +
                "Should match what they shared out-of-band.",
            },
          },
          required: ["action"],
        },
      },
    ],
  };
});

// ---- Tool handlers ----

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const toolName = request.params.name;
  const args = request.params.arguments ?? {};

  try {
    switch (toolName) {
      case "send_message":
        return await handleSendMessage(args as unknown as SendMessageInput);
      case "check_inbox":
        return await handleCheckInbox(args as unknown as CheckInboxInput);
      case "agent_pair":
        return await handleAgentPair(args as unknown as AgentPairInput);
      default:
        throw new Error(`Unknown tool: ${toolName}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text" as const, text: `Error: ${message}` }],
      isError: true,
    };
  }
});

// ---- send_message ----

async function handleSendMessage(
  input: SendMessageInput,
): Promise<{ content: { type: "text"; text: string }[] }> {
  const keyPair = loadKeyPair();
  const peers = loadPeers();

  // Resolve peer alias or raw pubkey
  const recipientPubKeyB64 = resolvePeer(input.peer, peers);
  if (!recipientPubKeyB64) {
    throw new Error(
      `Peer "${input.peer}" not found in peers list and is not a valid base64 public key. ` +
        "Use agent_pair to list known peers.",
    );
  }

  const recipientPubKey = util.decodeBase64(recipientPubKeyB64);
  const senderPrivKey = util.decodeBase64(keyPair.privateKey);
  const senderPubKey = util.decodeBase64(keyPair.publicKey);

  // Build plaintext payload
  const messageId = uuidv4();
  const payload: MessagePayload = {
    type: "message",
    id: messageId,
    from: agentId,
    to: input.peer,
    subject: input.subject?.slice(0, 200) ?? "",
    body: input.body,
    timestamp: new Date().toISOString(),
    in_reply_to: null,
  };

  const plaintextBytes = new TextEncoder().encode(JSON.stringify(payload));

  // Encrypt
  const encrypted = encrypt(plaintextBytes, recipientPubKey, senderPrivKey);

  // Sign the encrypted blob
  const signature = sign(encrypted, senderPrivKey);

  // Assemble wire format: encrypted || signature
  const wireBlob = new Uint8Array(encrypted.length + signature.length);
  wireBlob.set(encrypted, 0);
  wireBlob.set(signature, encrypted.length);

  const payloadB64 = util.encodeBase64(wireBlob);

  // Send to relay
  const messageUuid = await relayClient.send(
    keyPair.publicKey,
    recipientPubKeyB64,
    payloadB64,
  );

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ status: "sent", message_id: messageUuid }),
      },
    ],
  };
}

// ---- check_inbox ----

interface DecryptedMessage {
  id: string;
  from: string;
  subject: string;
  body: string;
  timestamp: string;
  in_reply_to: string | null;
}

async function handleCheckInbox(
  input: CheckInboxInput,
): Promise<{ content: { type: "text"; text: string }[] }> {
  const keyPair = loadKeyPair();
  const peers = loadPeers();
  const recipientPubKeyB64 = keyPair.publicKey;
  const recipientPrivKey = util.decodeBase64(keyPair.privateKey);

  // Poll relay
  const relayMessages = await relayClient.poll(
    recipientPubKeyB64,
    lastPollTime ?? undefined,
  );

  const decryptedMessages: DecryptedMessage[] = [];

  for (const msg of relayMessages) {
    try {
      const blob = util.decodeBase64(msg.payload);
      const signature = blob.slice(-64);
      const encryptedPart = blob.slice(0, -64);

      const senderPubKey = util.decodeBase64(msg.sender);

      // Verify signature
      const isValid = verify(encryptedPart, signature, senderPubKey);
      if (!isValid) {
        console.warn(`[agent-relay] Signature verification failed: ${msg.id}`);
        continue;
      }

      // Decrypt
      const plaintextBytes = decrypt(
        encryptedPart,
        recipientPrivKey,
        senderPubKey,
      );
      if (!plaintextBytes) {
        console.error(`[agent-relay] Decryption failed: ${msg.id}`);
        continue;
      }

      const payload: MessagePayload = JSON.parse(
        new TextDecoder().decode(plaintextBytes),
      );

      // Dedup — reject replayed messages
      if (seenMessageIds.has(payload.id)) {
        console.warn(`[agent-relay] Duplicate message ${payload.id} skipped`);
        continue;
      }
      trackMessageId(payload.id);

      // Handle pairing messages
      const senderB64 = msg.sender;

      if (payload.type === "pairing_request") {
        // Check if sender is already a peer
        if (!peers.peers[senderB64]) {
          try {
            const requestBody = JSON.parse(payload.body) as {
              pubkey?: string;
              alias?: string;
              fingerprint?: string;
            };
            pendingPairings.push({
              senderPubKey: senderB64,
              senderAlias: requestBody.alias || payload.from,
              fingerprint: requestBody.fingerprint || "",
              messageId: payload.id,
            });
          } catch {
            pendingPairings.push({
              senderPubKey: senderB64,
              senderAlias: payload.from,
              fingerprint: "",
              messageId: payload.id,
            });
          }
        }
        continue; // Don't surface pairing requests as regular messages
      }

      if (payload.type === "pairing_ack") {
        // Accept ack if peer isn't already known.
        // The signature verification above ensures this ack is authentic.
        // No in-memory guard needed — that state can be lost on restart.
        if (!peers.peers[senderB64]) {
          try {
            const ackBody = JSON.parse(payload.body) as {
              alias?: string;
              fingerprint?: string;
            };
            peers.peers[senderB64] = ackBody.alias || payload.from;
            savePeers(peers);
          } catch {
            peers.peers[senderB64] = payload.from;
            savePeers(peers);
          }
        }
        continue;
      }

      // Regular message — resolve sender alias
      const senderAlias =
        Object.entries(peers.peers).find(
          ([pubkey]) => pubkey === senderB64,
        )?.[1] || payload.from;

      decryptedMessages.push({
        id: payload.id,
        from: senderAlias,
        subject: payload.subject,
        body: payload.body,
        timestamp: payload.timestamp,
        in_reply_to: payload.in_reply_to,
      });
    } catch (err) {
      console.error(`[agent-relay] Error processing message ${msg.id}:`, err);
    }
  }

  // Update poll timestamp
  lastPollTime = new Date().toISOString();

  const hasPending = pendingPairings.length > 0;
  let resultText = JSON.stringify({ messages: decryptedMessages });

  if (hasPending) {
    resultText = JSON.stringify({
      messages: decryptedMessages,
      pending_pairings: pendingPairings.map((p) => ({
        alias: p.senderAlias,
        fingerprint: p.fingerprint,
      })),
    });
  }

  return {
    content: [{ type: "text", text: resultText }],
  };
}

// ---- agent_pair ----

async function handleAgentPair(
  input: AgentPairInput,
): Promise<{ content: { type: "text"; text: string }[] }> {
  const { action, peer_alias, peer_fingerprint } = input;

  switch (action) {
    case "initiate": {
      const keyPair = loadKeyPair();
      const fp = fingerprint(keyPair.publicKey);

      let result = `Share this fingerprint with your peer: ${fp}`;

      // If peer_alias is provided, treat it as the recipient's base64 pubkey
      // and send a pairing request
      if (peer_alias) {
        try {
          const recipientPubKey = util.decodeBase64(peer_alias);
          const senderPrivKey = util.decodeBase64(keyPair.privateKey);

          const messagePayload: MessagePayload = {
            type: "pairing_request",
            id: uuidv4(),
            from: agentId,
            to: peer_alias,
            subject: `Pairing request from ${agentId}`,
            body: JSON.stringify({
              pubkey: keyPair.publicKey,
              alias: agentId,
              fingerprint: fp,
            }),
            timestamp: new Date().toISOString(),
            in_reply_to: null,
          };

          const plaintextBytes = new TextEncoder().encode(
            JSON.stringify(messagePayload),
          );
          const encrypted = encrypt(
            plaintextBytes,
            recipientPubKey,
            senderPrivKey,
          );
          const signature = sign(encrypted, senderPrivKey);

          const wireBlob = new Uint8Array(
            encrypted.length + signature.length,
          );
          wireBlob.set(encrypted, 0);
          wireBlob.set(signature, encrypted.length);

          const payloadB64 = util.encodeBase64(wireBlob);

          await relayClient.send(
            keyPair.publicKey,
            peer_alias,
            payloadB64,
          );

          // Track this outbound pairing so we only accept ack from this peer
          pendingOutboundPairings.add(peer_alias);

          result += `\nPairing request sent to ${peer_alias}`;
        } catch (err) {
          result += `\nCould not send pairing request: ${err instanceof Error ? err.message : String(err)}`;
        }
      }

      return {
        content: [{ type: "text", text: result }],
      };
    }

    case "confirm": {
      if (!peer_alias) {
        throw new Error("peer_alias is required for confirm action");
      }
      if (!peer_fingerprint) {
        throw new Error("peer_fingerprint is required for confirm action");
      }

      // Search pending pairings
      const pending = pendingPairings.find(
        (p) => p.fingerprint === peer_fingerprint,
      );

      if (!pending) {
        // Try polling inbox to pick up any pairing requests we haven't seen
        await handleCheckInbox({ mark_read: true });

        const pendingAfterPoll = pendingPairings.find(
          (p) => p.fingerprint === peer_fingerprint,
        );

        if (!pendingAfterPoll) {
          throw new Error(
            `No pairing request found with fingerprint "${peer_fingerprint}". ` +
              "Make sure the other agent has sent a pairing request and you've checked your inbox.",
          );
        }

        // Found after poll — complete pairing
        const peers = loadPeers();
        peers.peers[pendingAfterPoll.senderPubKey] = peer_alias;
        savePeers(peers);

        // Send ack
        await sendPairingAck(pendingAfterPoll.senderPubKey, peer_alias);

        // Clean up pending
        const idx = pendingPairings.indexOf(pendingAfterPoll);
        if (idx >= 0) pendingPairings.splice(idx, 1);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: "paired",
                peer: peer_alias,
                fingerprint: peer_fingerprint,
              }),
            },
          ],
        };
      }

      // Found in pending list — complete pairing
      const peers = loadPeers();
      peers.peers[pending.senderPubKey] = peer_alias;
      savePeers(peers);

      // Send ack
      await sendPairingAck(pending.senderPubKey, peer_alias);

      // Clean up
      const idx = pendingPairings.indexOf(pending);
      if (idx >= 0) pendingPairings.splice(idx, 1);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              status: "paired",
              peer: peer_alias,
              fingerprint: peer_fingerprint,
            }),
          },
        ],
      };
    }

    case "list": {
      const peers = loadPeers();
      const formatted = formatPeerList(peers);

      return {
        content: [
          {
            type: "text",
            text: formatted,
          },
        ],
      };
    }

    case "remove": {
      if (!peer_alias) {
        throw new Error("peer_alias is required for remove action");
      }

      const peers = loadPeers();
      let removed = false;

      for (const [pubkey, alias] of Object.entries(peers.peers)) {
        if (alias === peer_alias) {
          delete peers.peers[pubkey];
          removed = true;
          break;
        }
      }

      if (!removed) {
        throw new Error(`Peer "${peer_alias}" not found`);
      }

      savePeers(peers);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ status: "removed", peer: peer_alias }),
          },
        ],
      };
    }

    default:
      throw new Error(
        `Unknown action "${action}". Use: initiate, confirm, list, remove`,
      );
  }
}

/** Send a pairing acknowledgment back to a peer after confirming. */
async function sendPairingAck(
  recipientPubKeyB64: string,
  peerAlias: string,
): Promise<void> {
  const keyPair = loadKeyPair();
  const recipientPubKey = util.decodeBase64(recipientPubKeyB64);
  const senderPrivKey = util.decodeBase64(keyPair.privateKey);
  const fp = fingerprint(keyPair.publicKey);

  const ackPayload: MessagePayload = {
    type: "pairing_ack",
    id: uuidv4(),
    from: agentId,
    to: peerAlias,
    subject: `Pairing confirmed with ${agentId}`,
    body: JSON.stringify({
      alias: agentId,
      fingerprint: fp,
    }),
    timestamp: new Date().toISOString(),
    in_reply_to: null,
  };

  const plaintextBytes = new TextEncoder().encode(JSON.stringify(ackPayload));
  const encrypted = encrypt(plaintextBytes, recipientPubKey, senderPrivKey);
  const signature = sign(encrypted, senderPrivKey);

  const wireBlob = new Uint8Array(encrypted.length + signature.length);
  wireBlob.set(encrypted, 0);
  wireBlob.set(signature, encrypted.length);

  const payloadB64 = util.encodeBase64(wireBlob);

  await relayClient.send(keyPair.publicKey, recipientPubKeyB64, payloadB64);
}

// ---- Start ----

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("[agent-relay] Fatal error:", err);
  process.exit(1);
});
