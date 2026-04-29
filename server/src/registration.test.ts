import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  publicRegistrationConfig,
  redeemInviteCode,
  validateInviteCode,
} from "./registration.js";

function withEnv(env: Record<string, string | undefined>, fn: () => void) {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(env)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("invite registration accepts configured plain invite code", () => {
  withEnv(
    {
      VAULTCHAT_REGISTRATION_MODE: "invite",
      VAULTCHAT_INVITE_CODES: "secret-code-123",
      VAULTCHAT_INVITE_CODE_HASHES: undefined,
    },
    () => {
      assert.deepEqual(validateInviteCode("secret-code-123"), { ok: true });
      assert.equal(validateInviteCode("wrong-code").error, "invalid_invite");
      assert.deepEqual(publicRegistrationConfig(), {
        mode: "invite",
        inviteRequired: true,
      });
    }
  );
});

test("invite registration accepts hashed invite code", () => {
  const hash = createHash("sha256").update("hashed-code-123", "utf8").digest("hex");
  withEnv(
    {
      VAULTCHAT_REGISTRATION_MODE: "invite",
      VAULTCHAT_INVITE_CODES: undefined,
      VAULTCHAT_INVITE_CODE_HASHES: hash,
    },
    () => {
      assert.deepEqual(validateInviteCode("hashed-code-123"), { ok: true });
    }
  );
});

test("closed registration rejects all new accounts", () => {
  withEnv({ VAULTCHAT_REGISTRATION_MODE: "closed" }, () => {
    assert.equal(validateInviteCode("secret-code-123").error, "registration_closed");
  });
});

test("persistent invite codes are single-use after redemption", () => {
  const dir = mkdtempSync(join(tmpdir(), "vaultchat-invite-"));
  withEnv(
    {
      VAULTCHAT_REGISTRATION_MODE: "invite",
      VAULTCHAT_INVITE_CODES: "single-use-code",
      VAULTCHAT_STATE_FILE: join(dir, "state.json"),
    },
    () => {
      try {
        assert.deepEqual(validateInviteCode("single-use-code"), { ok: true });
        redeemInviteCode("single-use-code");
        assert.equal(validateInviteCode("single-use-code").error, "invalid_invite");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  );
});
