import runtimeConfigSchema from '../runtime-config.schema'

export const sessionPassword = runtimeConfigSchema.shape.sessionPassword
export const timeoutMs = runtimeConfigSchema.shape.timeoutMs
export const cacheTtl = runtimeConfigSchema.shape.cacheTtl
export const redirectUrl = runtimeConfigSchema.shape.redirectUrl
export const publicPosthogHost = runtimeConfigSchema.shape.public.shape.posthog.shape.host
export const publicPosthogSampleRate = runtimeConfigSchema.shape.public.shape.posthog.shape.sampleRate
