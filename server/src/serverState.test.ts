import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  loadPersistedGroups,
  loadPersistedPreKeyBundles,
  loadPersistedUsers,
  persistPreKeyBundles,
  persistUsersAndGroups,
} from "./serverState.js";

test("server state persists directory and prekeys without overwriting each other", () => {
  const dir = mkdtempSync(join(tmpdir(), "vaultchat-state-"));
  process.env.VAULTCHAT_STATE_FILE = join(dir, "state.json");
  try {
    persistUsersAndGroups(
      [
        {
          id: "user-1",
          username: "alice",
          passwordHash: "argon2",
          publicKey: "identity",
          createdAt: 1,
        },
      ],
      [
        {
          id: "group-1",
          name: "secure",
          memberIds: ["user-1"],
          createdAt: 2,
        },
      ]
    );
    persistPreKeyBundles([
      {
        userId: "user-1",
        identityKey: "identity",
        signedPreKey: {
          keyId: 1,
          publicKey: "spk",
          signature: "sig",
        },
        oneTimePreKeys: [{ keyId: 7, publicKey: "otp" }],
        nextKeyId: 8,
      },
    ]);

    assert.equal(loadPersistedUsers()[0]?.username, "alice");
    assert.equal(loadPersistedGroups()[0]?.name, "secure");
    assert.equal(loadPersistedPreKeyBundles()[0]?.oneTimePreKeys[0]?.publicKey, "otp");
  } finally {
    delete process.env.VAULTCHAT_STATE_FILE;
    rmSync(dir, { recursive: true, force: true });
  }
});
