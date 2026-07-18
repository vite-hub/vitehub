import {
  defineSandbox,
  NotSupportedError,
  runSandbox,
  SandboxError,
  type SandboxErrorCode,
  type SandboxErrorDetails,
  type SandboxErrorJSON,
  type SandboxErrorOptions,
} from "@vite-hub/sandbox";

const options = {
  cause: new Error("private provider diagnostic"),
  code: "SANDBOX_TRANSPORT_ERROR",
  details: {
    operation: "create",
    provider: "vercel",
    status: 503,
    timeoutMs: 1_000,
  },
  message: "The provider request failed.",
} satisfies SandboxErrorOptions;

const error = new SandboxError(options);
error.code satisfies SandboxErrorCode;
error.details satisfies SandboxErrorDetails | undefined;
error.toJSON() satisfies SandboxErrorJSON;

new NotSupportedError("snapshot", "vercel").toJSON() satisfies SandboxErrorJSON;

const definition = defineSandbox(async (payload: { value: string }) => payload.value);
definition.run({ value: "ok" }) satisfies string | Promise<string>;

async function consumeResult() {
  const result = await runSandbox("missing", { value: "test" });
  if (result.isErr() && result.error) result.error satisfies SandboxError;
}

void consumeResult;
