export interface AdminCheckResponse {
  authenticated: true;
  stats: {
    tenants: number;
    agents: number;
    messages: number;
    uptime: number;
  };
}

export interface TenantRow {
  id: string;
  name: string;
  display_name: string;
  created_at: string;
  updated_at: string;
}

export interface TenantResponse {
  id: string;
  name: string;
  display_name: string;
  key_prefix: string;
  agent_count: number;
  message_count: number;
  created_at: string;
}

export interface AgentRow {
  id: string;
  tenant_id: string;
  pubkey: string;
  display_name: string;
  created_at: string;
  last_seen_at: string | null;
}

export interface AgentResponse {
  id: string;
  tenant_id: string;
  pubkey: string;
  display_name: string;
  last_seen_at: string | null;
  created_at: string;
}

export interface TenantKeyRow {
  id: string;
  key_prefix: string;
  is_active: number;
  created_at: string;
  rotated_at: string | null;
}

export interface CreateTenantRequest {
  name: string;
  display_name?: string;
}

export interface RotateKeyResponse {
  key: string;
  key_prefix: string;
}
