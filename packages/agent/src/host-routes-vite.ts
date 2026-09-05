import { createHash } from 'node:crypto'
import { hasRuntimeType } from './internal/runtime-type.ts'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Plugin, UserConfig } from 'vite'

export interface AgentHostRoute {
  exportName: string
  route?: string
}

/** Generate opt-in, host-authorized inspection routes from an Agent module. */
export function agentHostRoutes(options: {
  entry: string
  health?: string | AgentHostRoute
  workspace?: string | AgentHostRoute
}): Plugin {
  return {
    name: 'vitehub:agent-host-routes',
    async config(config) {
      const root = resolve(config.root ?? process.cwd())
      const entry = resolve(root, options.entry)
      const directory = resolve(root, '.vitehub/agent-host-routes')
      const handlers: { route: string, handler: string, method: 'get' | 'head' }[] = []
      // SAFETY: Nitro extends Vite configuration with optional route registrations.
      const existing = (config as UserConfig & { nitro?: { handlers?: { route?: string }[] } }).nitro?.handlers ?? []
      for (const kind of ['health', 'workspace'] as const) {
        const configured = options[kind]
        if (configured === undefined) continue
        const { exportName, route = kind === 'health' ? '/api/health' : '/api/_vitehub/console/invocations/:id/workspace' } = hasRuntimeType(configured, 'string') ? { exportName: configured } : configured
        if (!/^[$_\p{ID_Start}][$\u200C\u200D\p{ID_Continue}]*$/u.test(exportName))
          throw new Error('Agent host route exportName must be a JavaScript identifier.')
        if (!route.startsWith('/') || /[?#*]/.test(route) || (kind === 'workspace' && !route.split('/').includes(':id')))
          throw new Error('Agent host routes require an absolute path without query, hash, or wildcard; Workspace routes require an :id parameter.')
        if ([...existing, ...handlers].some(handler => handler.route === route))
          throw new Error(`Agent host route already registered: ${route}`)
        const handler = resolve(directory, `${kind}-${createHash('sha256').update(JSON.stringify([entry, exportName, route])).digest('hex').slice(0, 16)}.ts`)
        const moduleImport = exportName === 'default'
          ? `import inspect from ${JSON.stringify(entry)}`
          : `import { ${exportName} as inspect } from ${JSON.stringify(entry)}`
        const body = kind === 'health'
          ? `import { defineEventHandler } from 'h3'\n${moduleImport}\nexport default defineEventHandler(() => inspect())\n`
          : `import { defineEventHandler, getQuery, getRouterParam } from 'h3'\n${moduleImport}\nexport default defineEventHandler(event => { const path = getQuery(event).path; return inspect(getRouterParam(event, 'id') || '', typeof path === 'string' ? path : undefined) })\n`
        await mkdir(directory, { recursive: true })
        await writeFile(handler, body)
        handlers.push({ route, handler, method: 'get' }, { route, handler, method: 'head' })
      }
      const result: UserConfig & { nitro: { handlers: typeof handlers } } = { nitro: { handlers } }
      return result
    },
  }
}
