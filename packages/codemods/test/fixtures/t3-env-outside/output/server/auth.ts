import { useServerEnv } from "vite-hub/env";

export const secret = useServerEnv().betterAuthSecret.unseal();
