import { expect, test } from "vitest";
import { decodeBase64 } from "./encoding";
import { generateOwnerKeyPair, signChallenge, verifyChallenge } from "./crypto";

test("generates an Ed25519 owner identity and verifies Relay challenge signatures", async () => {
  const identity = await generateOwnerKeyPair();
  const nonce = new Uint8Array(32);
  globalThis.crypto.getRandomValues(nonce);
  const signature = await signChallenge(identity.privateKey, nonce);
  expect(decodeBase64(signature).length).toBe(64);
  expect(await verifyChallenge(identity.publicKey, nonce, signature)).toBe(true);
  nonce[0] ^= 1;
  expect(await verifyChallenge(identity.publicKey, nonce, signature)).toBe(false);
});
