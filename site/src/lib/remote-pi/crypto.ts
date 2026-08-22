import { getPublicKeyAsync, signAsync, verifyAsync } from "@noble/ed25519";
import { decodeBase64, encodeBase64 } from "./encoding";
import type { OwnerKeyPair } from "./types";

const ED25519_SEED_BYTES = 32;
const ED25519_PUBLIC_KEY_BYTES = 32;
const ED25519_SIGNATURE_BYTES = 64;

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  const source = globalThis.crypto;
  if (!source?.getRandomValues) throw new Error("Web Crypto random source is unavailable");
  source.getRandomValues(bytes);
  return bytes;
}

function asBytes(value: Uint8Array | string): Uint8Array {
  return typeof value === "string" ? decodeBase64(value) : value;
}

function assertLength(name: string, bytes: Uint8Array, length: number): void {
  if (bytes.length !== length) throw new Error(`${name} must be ${length} bytes`);
}

/** Generates a browser Owner identity. The private seed must never be logged or put in a URL. */
export async function generateOwnerKeyPair(): Promise<OwnerKeyPair> {
  const privateKey = randomBytes(ED25519_SEED_BYTES);
  const publicKey = await getPublicKeyAsync(privateKey);
  assertLength("Ed25519 private key", privateKey, ED25519_SEED_BYTES);
  assertLength("Ed25519 public key", publicKey, ED25519_PUBLIC_KEY_BYTES);
  return { privateKey, publicKey };
}

/** Signs the Relay's raw challenge nonce and returns standard base64 for the auth frame. */
export async function signChallenge(
  privateKey: Uint8Array,
  nonce: Uint8Array | string,
): Promise<string> {
  assertLength("Ed25519 private key", privateKey, ED25519_SEED_BYTES);
  const signature = await signAsync(asBytes(nonce), privateKey);
  assertLength("Ed25519 signature", signature, ED25519_SIGNATURE_BYTES);
  return encodeBase64(signature, "standard");
}

export async function verifyChallenge(
  publicKey: Uint8Array | string,
  nonce: Uint8Array | string,
  signature: Uint8Array | string,
): Promise<boolean> {
  const publicKeyBytes = asBytes(publicKey);
  const signatureBytes = asBytes(signature);
  assertLength("Ed25519 public key", publicKeyBytes, ED25519_PUBLIC_KEY_BYTES);
  assertLength("Ed25519 signature", signatureBytes, ED25519_SIGNATURE_BYTES);
  return verifyAsync(signatureBytes, asBytes(nonce), publicKeyBytes);
}

export function publicKeyToRelayId(publicKey: Uint8Array): string {
  assertLength("Ed25519 public key", publicKey, ED25519_PUBLIC_KEY_BYTES);
  return encodeBase64(publicKey, "standard");
}
