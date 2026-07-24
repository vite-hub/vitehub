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
  const getSandbox = options.getSandbox ?? await loadCloudflareSandbox();
  return await resolveRemoteBoxRuntime(
    createCloudflareRuntime({
      ...options,
      getSandbox,
    }),
    requirements,
  );
}

async function loadCloudflareSandbox(): Promise<NonNullable<CloudflareBoxOptions["getSandbox"]>> {
  const { getSandbox } = await import("@cloudflare/sandbox");
  return getSandbox as unknown as NonNullable<CloudflareBoxOptions["getSandbox"]>;
}
