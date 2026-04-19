function resolveSandboxConfig() {
  const preset = process.env.NITRO_PRESET || ''
  const explicit = process.env.SANDBOX_PROVIDER
  if (explicit === 'cloudflare' || explicit === 'vercel')
    return { provider: explicit as 'cloudflare' | 'vercel' }
  if (preset.includes('vercel'))
    return { provider: 'vercel' as const }
  return { provider: 'cloudflare' as const }
}

export default defineNuxtConfig({
  modules: ['@vitehub/sandbox/nuxt'],
  sandbox: resolveSandboxConfig(),
})
