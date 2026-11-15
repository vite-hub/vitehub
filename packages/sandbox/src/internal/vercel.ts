import type { Sandbox } from "../index.ts";
import { createVercelRuntime, type VercelSandboxOptions } from "../vercel.ts";
import { resolveRemoteSandboxRuntime } from "./remote.ts";

// `createVercelRuntime` loads `@vercel/sandbox` when `create` is not set, so Sandbox Tasks and
// `resolveSandbox()` share one SDK import.
export async function resolveVercelSandbox(
  options: VercelSandboxOptions,
  requirements: readonly string[],
): Promise<Sandbox> {
  return await resolveRemoteSandboxRuntime(createVercelRuntime(options), requirements);
}
