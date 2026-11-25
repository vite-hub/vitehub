import runtimeConfigSchema from '../schema'

export const apiSecret = runtimeConfigSchema.entries.apiSecret
export const allowedOrigins = runtimeConfigSchema.entries.allowedOrigins
export const port = runtimeConfigSchema.entries.port
export const publicApiBase = runtimeConfigSchema.entries.public.entries.apiBase
