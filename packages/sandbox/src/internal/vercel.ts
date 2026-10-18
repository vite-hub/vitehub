import type { Sandbox } from "../index.ts";
import {
  createVercelRuntime,
  type VercelSandboxOptions,
  type VercelSandboxCreateOptions,
  type VercelSandboxInstance,
} from "../vercel.ts";
import { resolveRemoteSandboxRuntime } from "./remote.ts";

export async function resolveVercelSandbox(
  options: VercelSandboxOptions,
  requirements: readonly string[],
): Promise<Sandbox> {
  const create = options.create ?? await loadVercelSandbox();
  return await resolveRemoteSandboxRuntime(
    createVercelRuntime({
      ...options,
      create,
    }),
    requirements,
  );
}

async function loadVercelSandbox(): Promise<NonNullable<VercelSandboxOptions["create"]>> {
  const { Sandbox } = await import("@vercel/sandbox");
  return async (createOptions: VercelSandboxCreateOptions) =>
    await Sandbox.create(
      createOptions as Parameters<typeof Sandbox.create>[0],
    ) as unknown as VercelSandboxInstance;
}
