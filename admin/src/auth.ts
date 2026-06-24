import { randomBytes, createHash } from "node:crypto";

const KEY_HASH_PREFIX = "agent-relay-key-v1:";

export function hashKey(key: string): string {
  return createHash("sha256")
    .update(KEY_HASH_PREFIX + key)
    .digest("hex");
}

export function generateKey(): string {
  return randomBytes(32).toString("hex");
}
