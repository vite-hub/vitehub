import { defineEnvProvider } from "vite-hub/env";
import type { SecretEnv } from "vite-hub/env";
import { resolveServerEnv, runWithCloudflareEnv } from "vite-hub/env/server";

export const vault = defineEnvProvider({ read: async () => ({}) });
export type Token = SecretEnv<string>;
export { resolveServerEnv, runWithCloudflareEnv };
