import { defineHandler } from "h3"
import { useServerEnv } from "#vitehub/env/server"
export default defineHandler((event) => ({ email: useServerEnv(event).drop.abuseEmail }))
