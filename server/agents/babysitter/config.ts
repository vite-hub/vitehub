import { defineAgent } from '@vite-hub/agent'
import { codexDriver } from '@vite-hub/agent/harness/codex'
import { crabbox } from '@vite-hub/box/crabbox'

export default defineAgent({
  box: {
    provider: crabbox({ network: 'direct', profile: 'babysitter', reclaim: true }),
    workspace: ({ input }) => {
      if (!input.options) throw new Error('Babysitter requires run options.')
      return input.options.worktreePath
    },
    requires: ['git', 'github', 'pnpm'],
  },
  driver: codexDriver<{ worktreePath: string }>(),
})
