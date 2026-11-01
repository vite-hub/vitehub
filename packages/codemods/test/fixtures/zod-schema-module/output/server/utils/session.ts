import type { H3Event } from 'h3'
import { useServerEnv } from '#vitehub/env/server'

export function sessionOptions(event: H3Event) {
  const { sessionPassword, webhook } = useServerEnv(event)
  return { password: sessionPassword, webhook }
}

export function cacheTtl() {
  const config = useServerEnv()
  return config['cacheTtl']
}

export function everything(event: H3Event) {
  return useSafeRuntimeConfig(event)
}
