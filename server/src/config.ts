export type DeploymentProfile = "development" | "preview" | "production";
export type RegistrationMode = "open" | "invite" | "closed";

export type RuntimeConfig = {
  nodeEnv: string;
  profile: DeploymentProfile;
  hasStrongJwtSecret: boolean;
  corsOrigins: string[];
  clientOrigins: string[];
  connectOrigins: string[];
  stateFileConfigured: boolean;
  allowEphemeralState: boolean;
  turnConfigured: boolean;
  forceRelay: boolean;
  registrationMode: RegistrationMode;
  inviteCodesConfigured: boolean;
  allowOpenRegistration: boolean;
};

function splitEnvList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function deploymentProfile(): DeploymentProfile {
  const raw = process.env.VAULTCHAT_DEPLOYMENT_PROFILE?.trim().toLowerCase();
  if (raw === "production" || raw === "preview" || raw === "development") return raw;
  return process.env.NODE_ENV === "production" ? "preview" : "development";
}

export function loadRuntimeConfig(): RuntimeConfig {
  const registrationMode = (() => {
    const raw = process.env.VAULTCHAT_REGISTRATION_MODE?.trim().toLowerCase();
    if (raw === "open" || raw === "invite" || raw === "closed") return raw;
    return "open";
  })();
  return {
    nodeEnv: process.env.NODE_ENV ?? "development",
    profile: deploymentProfile(),
    hasStrongJwtSecret: Boolean(
      process.env.VAULTCHAT_JWT_SECRET && process.env.VAULTCHAT_JWT_SECRET.length >= 32
    ),
    corsOrigins: splitEnvList(process.env.VAULTCHAT_CORS_ORIGIN),
    clientOrigins: splitEnvList(process.env.VAULTCHAT_CLIENT_ORIGINS),
    connectOrigins: splitEnvList(process.env.VAULTCHAT_CONNECT_ORIGINS),
    stateFileConfigured: Boolean(process.env.VAULTCHAT_STATE_FILE?.trim()),
    allowEphemeralState: process.env.VAULTCHAT_ALLOW_EPHEMERAL_STATE === "1",
    turnConfigured: splitEnvList(process.env.VAULTCHAT_TURN_URL).length > 0,
    forceRelay: process.env.VAULTCHAT_FORCE_RELAY === "1",
    registrationMode,
    inviteCodesConfigured: Boolean(
      process.env.VAULTCHAT_INVITE_CODES?.trim() ||
        process.env.VAULTCHAT_INVITE_CODE_HASHES?.trim()
    ),
    allowOpenRegistration: process.env.VAULTCHAT_ALLOW_OPEN_REGISTRATION === "1",
  };
}

export function validateRuntimeConfig(config = loadRuntimeConfig()): string[] {
  const problems: string[] = [];
  if (config.nodeEnv === "production" && !config.hasStrongJwtSecret) {
    problems.push("VAULTCHAT_JWT_SECRET must be at least 32 chars in NODE_ENV=production");
  }
  if (config.profile === "production") {
    if (!config.hasStrongJwtSecret) {
      problems.push("production profile requires VAULTCHAT_JWT_SECRET");
    }
    if (config.corsOrigins.length === 0) {
      problems.push("production profile requires VAULTCHAT_CORS_ORIGIN");
    }
    if (config.clientOrigins.length === 0) {
      problems.push("production profile requires VAULTCHAT_CLIENT_ORIGINS");
    }
    if (config.connectOrigins.length === 0) {
      problems.push("production profile requires VAULTCHAT_CONNECT_ORIGINS");
    }
    if (!config.stateFileConfigured && !config.allowEphemeralState) {
      problems.push(
        "production profile requires VAULTCHAT_STATE_FILE or explicit VAULTCHAT_ALLOW_EPHEMERAL_STATE=1"
      );
    }
    if (config.forceRelay && !config.turnConfigured) {
      problems.push("VAULTCHAT_FORCE_RELAY=1 requires VAULTCHAT_TURN_URL");
    }
    if (config.registrationMode === "open" && !config.allowOpenRegistration) {
      problems.push(
        "production profile requires VAULTCHAT_REGISTRATION_MODE=invite/closed or explicit VAULTCHAT_ALLOW_OPEN_REGISTRATION=1"
      );
    }
    if (config.registrationMode === "invite" && !config.inviteCodesConfigured) {
      problems.push("invite registration requires VAULTCHAT_INVITE_CODES or VAULTCHAT_INVITE_CODE_HASHES");
    }
  }
  return problems;
}

export function assertRuntimeConfig(): void {
  const problems = validateRuntimeConfig();
  if (problems.length === 0) return;
  throw new Error(`VaultChat configuration invalid:\n- ${problems.join("\n- ")}`);
}
