import { useServerEnv } from "vite-hub/env"

export default defineEventHandler((event) => { const c = useServerEnv(event); return c.allowedOrigins.length + c.port })
