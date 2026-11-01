import type { H3Event } from 'h3'

export function sessionOptions(event: H3Event) {
  const { sessionPassword, webhook } = useSafeRuntimeConfig(event)
  return { password: sessionPassword, webhook }
}

export function cacheTtl() {
  const config = useSafeRuntimeConfig()
  return config['cacheTtl']
}

export function everything(event: H3Event) {
  return useSafeRuntimeConfig(event)
}
