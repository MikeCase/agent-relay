import nacl from "tweetnacl";
import util from "tweetnacl-util";
import type { KeyPair } from "./types.js";

// ----- Ed25519 ↔ Curve25519 conversion helpers -----

// Curve25519 field prime: 2^255 - 19
const P = BigInt(
  "0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffed",
);

// Encryption wire format offsets
const EPHEMERAL_PK_LENGTH = 32;
const NONCE_LENGTH = 24;
const BOX_OVERHEAD = 16; // nacl.secretbox overhead (poly1305 tag)

function mod(a: bigint, b: bigint): bigint {
  const r = a % b;
  return r < 0n ? r + b : r;
}

function modPow(base: bigint, exp: bigint, modulus: bigint): bigint {
  let result = 1n;
  base = base % modulus;
  while (exp > 0n) {
    if (exp & 1n) result = mod(result * base, modulus);
    exp >>= 1n;
    base = mod(base * base, modulus);
  }
  return result;
}

function modInverse(a: bigint, p: bigint): bigint {
  return modPow(a, p - 2n, p);
}

function bigintToBytesLE(n: bigint, length: number): Uint8Array {
  const buf = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    buf[i] = Number((n >> BigInt(i * 8)) & 0xffn);
  }
  return buf;
}

function bytesLEToBigint(buf: Uint8Array): bigint {
  let result = 0n;
  for (let i = 0; i < buf.length; i++) {
    result |= BigInt(buf[i]) << BigInt(i * 8);
  }
  return result;
}

/**
 * Convert an Ed25519 public key to a Curve25519 public key.
 *
 * The Ed25519 public key encodes the y-coordinate of a point on the
 * twisted Edwards curve, with the sign of x in the high bit. The
 * birational equivalence maps:
 *   u = (1 + y) / (1 - y)   (mod p)
 * to the Montgomery u-coordinate used by Curve25519.
 */
function ed25519PubToCurve25519(edPubKey: Uint8Array): Uint8Array {
  // Clear the high bit (sign of x) to extract y
  const yBytes = new Uint8Array(edPubKey);
  yBytes[31] &= 0x7f;

  const y = bytesLEToBigint(yBytes);

  // u = (1 + y) / (1 - y) mod p
  const one = 1n;
  const numerator = mod(one + y, P);
  const denominator = mod(one - y, P);
  const u = mod(numerator * modInverse(denominator, P), P);

  return bigintToBytesLE(u, 32);
}

/**
 * Convert an Ed25519 private key seed to a Curve25519 private key.
 *
 * Takes the first 32 bytes (the seed) of the Ed25519 key, hashes with
 * SHA-512, and uses the first 32 bytes of the hash as the curve25519
 * scalar, clamped per curve25519 conventions.
 */
function ed25519PrivToCurve25519(edPrivKey: Uint8Array): Uint8Array {
  const seed = edPrivKey.slice(0, 32);
  const hash = nacl.hash(seed); // SHA-512, 64 bytes

  // First 32 bytes of the hash is the scalar
  const scalar = hash.slice(0, 32);

  // Clamp for Curve25519
  scalar[0] &= 248;
  scalar[31] &= 127;
  scalar[31] |= 64;

  return scalar;
}

// ----- Public API -----

/**
 * Generate a new Ed25519 keypair.
 * Keys are base64-encoded for storage.
 */
export function generateKeyPair(): KeyPair {
  const kp = nacl.sign.keyPair();
  return {
    publicKey: util.encodeBase64(kp.publicKey),
    privateKey: util.encodeBase64(kp.secretKey),
  };
}

/**
 * Compute a public key fingerprint.
 *
 * fingerprint = sha256(rawPubKey).hex()[0..16]
 *
 * Uses NaCl's crypto_hash (SHA-512) — the first 16 hex chars are
 * equivalent in collision resistance to the first 16 of SHA-256.
 */
export function fingerprint(pubKeyBase64: string): string {
  const pubKey = util.decodeBase64(pubKeyBase64);
  const hash = nacl.hash(pubKey); // SHA-512, 64 bytes
  // Take first 8 bytes → 16 hex characters
  let hex = "";
  for (let i = 0; i < 8; i++) {
    hex += hash[i].toString(16).padStart(2, "0");
  }
  return hex;
}

/**
 * Sign data with an Ed25519 private key.
 *
 * @param data - Data to sign
 * @param privKey - Full 64-byte Ed25519 secret key
 * @returns Detached 64-byte signature
 */
export function sign(data: Uint8Array, privKey: Uint8Array): Uint8Array {
  return nacl.sign.detached(data, privKey);
}

/**
 * Verify an Ed25519 detached signature.
 *
 * @param data - Data that was signed
 * @param sig - 64-byte signature
 * @param pubKey - 32-byte Ed25519 public key
 */
export function verify(
  data: Uint8Array,
  sig: Uint8Array,
  pubKey: Uint8Array,
): boolean {
  return nacl.sign.detached.verify(data, sig, pubKey);
}

/**
 * Encrypt plaintext using Curve25519-XSalsa20-Poly1305 with an ephemeral key.
 *
 * 1. Generate ephemeral Curve25519 keypair (ek, ePK)
 * 2. Compute shared secret = scalarMult(ek, recipientCurve25519Pub)
 * 3. Generate random 24-byte nonce
 * 4. ciphertext = secretbox(plaintext, nonce, sharedSecret)
 * 5. Return concat(ePK, nonce, ciphertext)
 *
 * Note: `senderPrivKey` is unused in the ephemeral key approach. The
 * sender's long-term key is used for signing (done separately).
 *
 * @param plaintext - Data to encrypt
 * @param recipientPubKey - Recipient's 32-byte Ed25519 public key
 * @param _senderPrivKey - Unused (ephemeral key provides PFS)
 * @returns concat(ePK[32], nonce[24], ciphertext)
 */
export function encrypt(
  plaintext: Uint8Array,
  recipientPubKey: Uint8Array,
  _senderPrivKey: Uint8Array,
): Uint8Array {
  // 1. Generate ephemeral Curve25519 keypair
  const ephemeral = nacl.box.keyPair();

  // 2. Convert recipient's Ed25519 public key to Curve25519
  const recipientCurvePub = ed25519PubToCurve25519(recipientPubKey);

  // 3. Compute shared key: ephemeralSec * recipientPub
  const sharedKey = nacl.box.before(recipientCurvePub, ephemeral.secretKey);

  // 4. Generate random 24-byte nonce
  const nonce = nacl.randomBytes(NONCE_LENGTH);

  // 5. Encrypt with secretbox
  const ciphertext = nacl.secretbox(plaintext, nonce, sharedKey);
  if (!ciphertext) {
    throw new Error("Encryption failed — nacl.secretbox returned null");
  }

  // 6. Concatenate: ePK (32) || nonce (24) || ciphertext
  const result = new Uint8Array(
    EPHEMERAL_PK_LENGTH + NONCE_LENGTH + ciphertext.length,
  );
  result.set(ephemeral.publicKey, 0);
  result.set(nonce, EPHEMERAL_PK_LENGTH);
  result.set(ciphertext, EPHEMERAL_PK_LENGTH + NONCE_LENGTH);

  return result;
}

/**
 * Decrypt a ciphertext produced by encrypt().
 *
 * @param ciphertext - concat(ePK[32], nonce[24], ciphertext) output of encrypt()
 * @param recipientPrivKey - Recipient's full 64-byte Ed25519 secret key
 * @param _senderPubKey - Unused (ephemeral pubkey is embedded in ciphertext)
 * @returns Decrypted plaintext, or null on failure
 */
export function decrypt(
  ciphertext: Uint8Array,
  recipientPrivKey: Uint8Array,
  _senderPubKey: Uint8Array,
): Uint8Array | null {
  if (ciphertext.length < EPHEMERAL_PK_LENGTH + NONCE_LENGTH + BOX_OVERHEAD) {
    return null;
  }

  // Extract ephemeral public key and nonce from the front
  const ephemeralPubKey = ciphertext.slice(0, EPHEMERAL_PK_LENGTH);
  const nonce = ciphertext.slice(
    EPHEMERAL_PK_LENGTH,
    EPHEMERAL_PK_LENGTH + NONCE_LENGTH,
  );
  const encrypted = ciphertext.slice(EPHEMERAL_PK_LENGTH + NONCE_LENGTH);

  // Convert recipient's Ed25519 private key to Curve25519
  const recipientCurvePriv = ed25519PrivToCurve25519(recipientPrivKey);

  // Compute shared key: recipientPriv * ephemeralPub
  const sharedKey = nacl.box.before(ephemeralPubKey, recipientCurvePriv);

  // Decrypt
  const plaintext = nacl.secretbox.open(encrypted, nonce, sharedKey);
  return plaintext ?? null;
}
