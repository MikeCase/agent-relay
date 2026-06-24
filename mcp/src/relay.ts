import type { RelayClientConfig, RelayMessage, HealthResponse } from "./types.js";

/**
 * HTTP client for the Agent Relay server.
 *
 * Implements retry logic per SPEC.md §9:
 * - 429 → exponential backoff (1s, 2s, 4s, max 30s, up to 5 attempts)
 * - 5xx → retry 3 times with 5s backoff
 * - 401 → fail immediately (auth mismatch)
 * - Timeout → retry once after 10s
 */
export class RelayClient {
  private config: RelayClientConfig;

  constructor(config: RelayClientConfig) {
    // Normalize URL — remove trailing slash
    this.config = {
      ...config,
      relayUrl: config.relayUrl.replace(/\/+$/, ""),
    };
  }

  /**
   * POST /api/v1/send
   * Returns the stored message UUID.
   */
  async send(
    sender: string,
    recipient: string,
    payload: string,
  ): Promise<string> {
    const body = { sender, recipient, payload };

    const response = await this.requestWithRetry("POST", "/api/v1/send", body);

    if (response.status === 413) {
      throw new Error("Payload too large (max 1MB)");
    }
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Send failed (${response.status}): ${text}`);
    }

    const data = (await response.json()) as { id: string };
    return data.id;
  }

  /**
   * GET /api/v1/poll?recipient=<base64>&since=<ISO8601>
   */
  async poll(recipient: string, since?: string): Promise<RelayMessage[]> {
    const params = new URLSearchParams({ recipient });
    if (since) {
      params.set("since", since);
    }

    const response = await this.requestWithRetry(
      "GET",
      `/api/v1/poll?${params}`,
    );

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Poll failed (${response.status}): ${text}`);
    }

    const data = (await response.json()) as { messages: RelayMessage[] };
    return data.messages;
  }

  /**
   * GET /api/v1/health
   */
  async health(): Promise<HealthResponse> {
    const response = await this.requestWithRetry("GET", "/api/v1/health");

    if (!response.ok) {
      throw new Error(`Health check failed (${response.status})`);
    }

    return response.json() as Promise<HealthResponse>;
  }

  // ---- Internal helpers ----

  private async requestWithRetry(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> {
    const url = `${this.config.relayUrl}${path}`;
    const headers: Record<string, string> = {};
    if (body) headers["Content-Type"] = "application/json";
    if (this.config.relayAuthKey) {
      headers["X-Relay-Key"] = this.config.relayAuthKey;
    }

    const doFetch = (): Promise<Response> =>
      fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });

    // First attempt
    let response = await this.catchTimeout(doFetch);

    // Handle 429 — exponential backoff
    if (response && response.status === 429) {
      for (let attempt = 0; attempt < 5; attempt++) {
        const delay = Math.min(1000 * 2 ** attempt, 30000);
        await sleep(delay);
        response = await this.catchTimeout(doFetch);
        if (!response || response.status !== 429) break;
      }
      if (response && response.status === 429) {
        throw new Error("Rate limited — max retries exceeded");
      }
    }

    // Handle 5xx — retry 3 times with 5s backoff
    if (response && response.status >= 500) {
      for (let attempt = 0; attempt < 3; attempt++) {
        await sleep(5000);
        response = await this.catchTimeout(doFetch);
        if (!response || response.status < 500) break;
      }
    }

    // Handle auth failure
    if (response && response.status === 401) {
      throw new Error(
        "Relay authentication failed — check AGENT_RELAY_KEY",
      );
    }

    if (!response) {
      throw new Error("Request failed after retries");
    }

    return response;
  }

  /**
   * Catch network timeouts and retry once after 10s.
   * Returns the response or null if all retries failed.
   */
  private async catchTimeout(
    fn: () => Promise<Response>,
  ): Promise<Response | null> {
    try {
      return await fn();
    } catch (err) {
      // Retry once after 10s on network error / timeout
      await sleep(10000);
      try {
        return await fn();
      } catch (innerErr) {
        return null;
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
