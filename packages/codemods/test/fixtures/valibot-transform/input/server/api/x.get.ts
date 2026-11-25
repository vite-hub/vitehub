export default defineEventHandler((event) => { const c = useSafeRuntimeConfig(event); return c.allowedOrigins.length + c.port })
