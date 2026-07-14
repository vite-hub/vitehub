import { defineAgent } from '@vite-hub/agent'
import { skills } from '@vite-hub/agent/capabilities'
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
  capabilities: [
    skills({
      path: 'skills/pr-comment-sentinel',
      scope: 'global',
      source: {
        ref: 'f1d406e7411bd98966f7987e4bf76610b037a182',
        repo: 'onmax/skills',
        root: 'skills/pr-comment-sentinel',
      },
    }),
    skills({
      path: 'skills/ponytail',
      scope: 'global',
      source: {
        ref: '14a0d79548d4de8fc2de95c1b94bb0de63a739d3',
        repo: 'DietrichGebert/ponytail',
        root: 'skills/ponytail',
      },
    }),
    skills({
      path: 'skills/code-review',
      scope: 'global',
      source: {
        ref: '66898f60e8c744e269f8ce06c2b2b99ce7660d5f',
        repo: 'mattpocock/skills',
        root: 'skills/engineering/code-review',
      },
    }),
  ],
  driver: codexDriver<{ worktreePath: string }>(),
})
