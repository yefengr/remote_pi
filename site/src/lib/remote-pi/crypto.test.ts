import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeBase64 } from "./encoding";
import { generateOwnerKeyPair, signChallenge, verifyChallenge } from "./crypto";

test("generates an Ed25519 owner identity and verifies Relay challenge signatures", async () => {
  const identity = await generateOwnerKeyPair();
  const nonce = new Uint8Array(32);
  globalThis.crypto.getRandomValues(nonce);
  const signature = await signChallenge(identity.privateKey, nonce);
  assert.equal(decodeBase64(signature).length, 64);
  assert.equal(await verifyChallenge(identity.publicKey, nonce, signature), true);
  nonce[0] ^= 1;
  assert.equal(await verifyChallenge(identity.publicKey, nonce, signature), false);
});
