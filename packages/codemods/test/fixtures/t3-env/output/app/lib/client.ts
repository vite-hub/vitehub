import { usePublicEnv } from "#vitehub/env/public";

export const baseURL = `${usePublicEnv().appUrl}/api`;
