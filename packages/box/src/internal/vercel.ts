import type { Box } from "../index.ts";
import {
  createVercelRuntime,
  type VercelBoxOptions,
  type VercelSandboxCreateOptions,
  type VercelSandboxInstance,
} from "../vercel.ts";
import { resolveRemoteBoxRuntime } from "./remote.ts";

export async function resolveVercelBox(
  options: VercelBoxOptions,
  requirements: readonly string[],
): Promise<Box> {
  const { Sandbox } = await import("@vercel/sandbox");
  return await resolveRemoteBoxRuntime(
    createVercelRuntime({
      ...options,
      create: options.create ?? (async (createOptions: VercelSandboxCreateOptions) =>
        await Sandbox.create(
          createOptions as Parameters<typeof Sandbox.create>[0],
        ) as unknown as VercelSandboxInstance),
    }),
    requirements,
  );
}
