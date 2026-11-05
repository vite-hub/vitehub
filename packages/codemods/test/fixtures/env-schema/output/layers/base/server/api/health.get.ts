import { usePublicEnv } from "#vitehub/env/public"

export default defineEventHandler(() => ({ level: usePublicEnv().logLevel }))
