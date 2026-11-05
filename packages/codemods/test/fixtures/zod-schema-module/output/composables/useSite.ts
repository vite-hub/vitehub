import { usePublicEnv } from '#vitehub/env/public'

export function useSite() {
  const { siteName } = usePublicEnv()
  return { siteName, host: usePublicEnv().posthogHost }
}
