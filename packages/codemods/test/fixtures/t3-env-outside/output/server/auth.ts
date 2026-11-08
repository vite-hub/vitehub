import { useServerEnv } from "#vitehub/env/server";

export const secret = useServerEnv().betterAuthSecret.unseal();
