import assert from "node:assert/strict";
import test from "node:test";
import { validateRuntimeConfig, type RuntimeConfig } from "./config.js";

const baseConfig: RuntimeConfig = {
  nodeEnv: "production",
  profile: "production",
  hasStrongJwtSecret: true,
  hasEmailHashSecret: true,
  corsOrigins: ["https://chat.example.org"],
  clientOrigins: ["https://chat.example.org"],
  connectOrigins: ["https://chat.example.org"],
  stateFileConfigured: true,
  allowEphemeralState: false,
  turnConfigured: true,
  forceRelay: true,
  registrationMode: "invite",
  inviteCodesConfigured: true,
  allowOpenRegistration: false,
};

test("production profile accepts complete product configuration", () => {
  assert.deepEqual(validateRuntimeConfig(baseConfig), []);
});

test("production profile rejects accidental ephemeral state", () => {
  const problems = validateRuntimeConfig({
    ...baseConfig,
    stateFileConfigured: false,
  });
  assert.match(problems.join("\n"), /VAULTCHAT_STATE_FILE/);
});

test("production force relay requires TURN", () => {
  const problems = validateRuntimeConfig({
    ...baseConfig,
    turnConfigured: false,
  });
  assert.match(problems.join("\n"), /VAULTCHAT_TURN_URL/);
});

test("production rejects accidental open registration", () => {
  const problems = validateRuntimeConfig({
    ...baseConfig,
    registrationMode: "open",
  });
  assert.match(problems.join("\n"), /VAULTCHAT_REGISTRATION_MODE/);
});

test("production invite mode requires configured invite codes", () => {
  const problems = validateRuntimeConfig({
    ...baseConfig,
    inviteCodesConfigured: false,
  });
  assert.match(problems.join("\n"), /VAULTCHAT_INVITE_CODES/);
});
