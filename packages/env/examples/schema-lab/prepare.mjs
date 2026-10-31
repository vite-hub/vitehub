import { fileURLToPath } from "node:url";

import { envSchema, hubEnv } from "@vite-hub/env/vite";

const root = fileURLToPath(new URL(".", import.meta.url));
await hubEnv().api.prepareTypes(envSchema(new URL("./.env.example", import.meta.url)), root);
