import { defineEnvProvider, resolveServerEnv, runWithCloudflareEnv } from "vite-hub/env";
import type { SecretEnv } from "vite-hub/env";

export const vault = defineEnvProvider({ read: async () => ({}) });
export type Token = SecretEnv<string>;
export { resolveServerEnv, runWithCloudflareEnv };
