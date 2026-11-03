import type { Sandbox } from "../index.ts";
import {
  createCloudflareRuntime,
  type CloudflareSandboxOptions,
} from "../cloudflare.ts";
import { resolveRemoteSandboxRuntime } from "./remote.ts";

export { createCloudflareSandboxDurableObject } from "./cloudflare-durable-object.ts";

export async function resolveCloudflareSandbox(
  options: CloudflareSandboxOptions,
  requirements: readonly string[],
): Promise<Sandbox> {
  return await resolveRemoteSandboxRuntime(createCloudflareRuntime(options), requirements);
}
