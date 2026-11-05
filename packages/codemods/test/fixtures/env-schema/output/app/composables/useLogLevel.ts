import { usePublicEnv } from "#vitehub/env/public";

export const useLogLevel = () => usePublicEnv().logLevel;
