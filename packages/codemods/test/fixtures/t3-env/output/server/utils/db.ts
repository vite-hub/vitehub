import { useServerEnv } from "vite-hub/env";

export const databaseUrl = useServerEnv().databaseUrl.unseal();
