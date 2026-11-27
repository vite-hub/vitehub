import { defineHandler } from "h3"
import { useServerEnv } from "vite-hub/env"
export default defineHandler((event) => ({ email: useServerEnv(event).drop.abuseEmail }))
