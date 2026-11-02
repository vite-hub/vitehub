import { useSafeRuntimeConfig } from '#imports'

export function useSite() {
  const { public: { siteName } } = useSafeRuntimeConfig()
  return { siteName, host: useSafeRuntimeConfig().public.posthog.host }
}
