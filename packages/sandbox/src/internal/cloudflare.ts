import type { Sandbox } from "../index.ts";
import {
  createCloudflareRuntime,
  type CloudflareSandboxOptions,
} from "../cloudflare.ts";
import { resolveRemoteSandboxRuntime } from "./remote.ts";

export async function resolveCloudflareSandbox(
  options: CloudflareSandboxOptions,
  requirements: readonly string[],
): Promise<Sandbox> {
  const getSandbox = options.getSandbox ?? await loadCloudflareSandbox();
  return await resolveRemoteSandboxRuntime(
    createCloudflareRuntime({
      ...options,
      getSandbox,
    }),
    requirements,
  );
}

async function loadCloudflareSandbox(): Promise<NonNullable<CloudflareSandboxOptions["getSandbox"]>> {
  const { getSandbox } = await import("@cloudflare/sandbox");
  return getSandbox as unknown as NonNullable<CloudflareSandboxOptions["getSandbox"]>;
}
