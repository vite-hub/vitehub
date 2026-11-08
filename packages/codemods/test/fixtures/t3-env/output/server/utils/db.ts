import { useServerEnv } from "#vitehub/env/server";

export const databaseUrl = useServerEnv().databaseUrl.unseal();
