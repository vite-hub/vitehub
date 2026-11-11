import { defineEnvProvider } from "vite-hub/env/provider";
import type { SecretEnv } from "vite-hub/env/secret";
import { resolveServerEnv, runWithCloudflareEnv } from "vite-hub/env/server";

export const vault = defineEnvProvider({ read: async () => ({}) });
export type Token = SecretEnv<string>;
export { resolveServerEnv, runWithCloudflareEnv };
