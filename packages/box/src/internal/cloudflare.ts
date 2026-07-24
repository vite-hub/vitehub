import type { Box } from "../index.ts";
import {
  createCloudflareRuntime,
  type CloudflareBoxOptions,
} from "../cloudflare.ts";
import { resolveRemoteBoxRuntime } from "./remote.ts";

export async function resolveCloudflareBox(
  options: CloudflareBoxOptions,
  requirements: readonly string[],
): Promise<Box> {
  const { getSandbox } = await import("@cloudflare/sandbox");
  return await resolveRemoteBoxRuntime(
    createCloudflareRuntime({
      ...options,
      getSandbox: options.getSandbox
        ?? getSandbox as unknown as NonNullable<CloudflareBoxOptions["getSandbox"]>,
    }),
    requirements,
  );
}
