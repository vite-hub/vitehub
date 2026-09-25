import { ViteHubError, isViteHubError } from "@vite-hub/runtime";
const messages = {
  denied: "Env access denied.",
  conflict: "The credential changed. Refresh before replacing it.",
  missing: "Credential unavailable.",
  invalid: "Invalid Env request.",
  operation_failed: "Env operation failed.",
  audit_failed: "Env activity could not be persisted.",
} as const;

export function envBridgeError(code: keyof typeof messages): ViteHubError {
  return new ViteHubError(`ENV_BRIDGE_${code.toUpperCase()}`, messages[code]);
}

export function sanitizeEnvBridgeError(error: unknown): ViteHubError {
  if (isViteHubError(error)) {
    for (const code of [
      "denied",
      "conflict",
      "missing",
      "invalid",
      "operation_failed",
      "audit_failed",
    ] as const) {
      if (error.code === `ENV_BRIDGE_${code.toUpperCase()}`) return envBridgeError(code);
    }
  }
  return envBridgeError("operation_failed");
}
