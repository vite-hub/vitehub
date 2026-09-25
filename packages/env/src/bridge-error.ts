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
  const code = isViteHubError(error)
    ? Object.keys(messages).find((key) => error.code === `ENV_BRIDGE_${key.toUpperCase()}`)
    : undefined;
  return envBridgeError((code as keyof typeof messages | undefined) ?? "operation_failed");
}
