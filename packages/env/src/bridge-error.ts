import { defineDiagnostics } from "nostics";
import { ViteHubError, isViteHubError } from "@vite-hub/runtime";
const messages = {
  denied: "Env access denied.",
  conflict: "The credential changed. Refresh before replacing it.",
  missing: "Credential unavailable.",
  invalid: "Invalid Env request.",
  operation_failed: "Env operation failed.",
  audit_failed: "Env activity could not be persisted.",
  untrusted: "Env did not create this access context.",
} as const;

export function envBridgeError(code: keyof typeof messages): ViteHubError {
  return new ViteHubError(`ENV_BRIDGE_${code.toUpperCase()}`, messages[code]);
}

const docs = "https://vitehub.dev/docs/env/bridge#structured-errors";
const guidance = (fix: string) => ({ why: ({ message }: { message: string }) => message, fix, docs });

/** Repair guidance that the management route adds to each bridge error body. */
const envBridgeDiagnostics = /*#__PURE__*/ defineDiagnostics({
  codes: {
    ENV_BRIDGE_DENIED: guidance("Ask an Env admin to grant the permission for this key."),
    ENV_BRIDGE_CONFLICT: guidance("Reload the credential details, then replace it again."),
    ENV_BRIDGE_MISSING: guidance("Store a value for this credential first."),
    ENV_BRIDGE_INVALID: guidance("Check the request fields and the stored value limits, then send it again."),
    ENV_BRIDGE_OPERATION_FAILED: guidance("Try again. If this continues, read the server logs for this request."),
    ENV_BRIDGE_AUDIT_FAILED: guidance("Check the Env activity store, then try again."),
    ENV_BRIDGE_UNTRUSTED: guidance("Create the access context with the Env bridge authenticate function."),
  },
});

/** The JSON error body of a sanitized bridge error: `code`, `message` (the why), `fix`, and `docs`. */
export function envBridgeErrorBody(error: ViteHubError): { code: string; docs?: string; fix?: string; message: string } {
  const code = error.code;
  if (!isEnvBridgeDiagnosticCode(code)) return { code, message: error.message };
  const diagnostic = envBridgeDiagnostics[code]({ message: error.message });
  return { code, docs: diagnostic.docs, fix: diagnostic.fix, message: error.message };
}

function isEnvBridgeDiagnosticCode(code: string): code is keyof typeof envBridgeDiagnostics {
  return Object.hasOwn(envBridgeDiagnostics, code);
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
      "untrusted",
    ] as const) {
      if (error.code === `ENV_BRIDGE_${code.toUpperCase()}`) return envBridgeError(code);
    }
  }
  return envBridgeError("operation_failed");
}
