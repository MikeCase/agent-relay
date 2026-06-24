export interface KeyPair {
  publicKey: string; // base64
  privateKey: string; // base64
}

export interface PeerEntry {
  publicKey: string; // base64
  alias: string;
}

export interface PeersFile {
  peers: Record<string, string>; // pubkey base64 -> alias
}

export interface MessagePayload {
  type: "message" | "pairing_request" | "pairing_ack";
  id: string;
  from: string;
  to: string;
  subject: string;
  body: string;
  timestamp: string; // ISO 8601
  in_reply_to: string | null;
}

export interface SendMessageInput {
  peer: string;
  subject?: string;
  body: string;
}

export interface CheckInboxInput {
  mark_read?: boolean;
}

export interface AgentPairInput {
  action: "initiate" | "confirm" | "list" | "remove";
  peer_alias?: string;
  peer_fingerprint?: string;
}

export interface RelayMessage {
  id: string;
  sender: string;
  recipient: string;
  payload: string;
  created_at: string;
}

export interface RelayClientConfig {
  relayUrl: string;
  relayAuthKey?: string;
}

export interface HealthResponse {
  status: string;
  uptime: number;
  message_count: number;
}
