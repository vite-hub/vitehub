import { useServerEnv } from '#vitehub/env/server'

const { token, url } = useServerEnv().console

if (url && !token) throw new Error('VITEHUB_CONSOLE_TOKEN is required when VITEHUB_CONSOLE_URL is configured.')
if (token && !url) throw new Error('VITEHUB_CONSOLE_URL is required when VITEHUB_CONSOLE_TOKEN is configured.')

export const consoleClient = url && token
  ? {
      endpoint: (path: string) => new URL(path, url).toString(),
      headers: () => ({ authorization: `Bearer ${token.unseal()}` }),
    }
  : undefined
