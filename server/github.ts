import { useServerEnv } from '#vitehub/env/server'
import { createGitHubHost } from 'vite-hub/agent/server'

export const github = createGitHubHost({
  credentials: () => useServerEnv().github,
  identity: {
    email: '320448255+vitehub-bot[bot]@users.noreply.github.com',
    login: 'vitehub-bot[bot]',
  },
})
