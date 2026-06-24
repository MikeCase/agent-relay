export interface SendRequest {
  sender: string;
  recipient: string;
  payload: string;
}

export interface SendResponse {
  id: string;
  status: "stored";
}

export interface PollResponse {
  messages: StoredMessage[];
}

export interface StoredMessage {
  id: string;
  sender: string;
  recipient: string;
  payload: string;
  created_at: string;
}

export interface HealthResponse {
  status: "ok";
  uptime: number;
  message_count: number;
}

export interface ServerConfig {
  port: number;
  host: string;
  dbPath: string;
  tenants: Record<string, string>;
  tenant?: string;
  messageTtlDays: number;
  maxPayloadBytes: number;
}

export interface DbActiveKey {
  key_hash: string;
  tenant_id: string;
  tenant_name: string;
}
