import { ownModule } from '@vite-hub/internal/build/paths'
import { agentHostWorkspaceRoute } from './server/host-workspace.ts'
import { agentDiagnostics } from './agent-diagnostics.ts'
import { createHash } from 'node:crypto'
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
      const plugins: string[] = []
      const handlers: { route: string, handler: string, method: 'GET' | 'HEAD' }[] = []
      // SAFETY: Nitro extends Vite configuration with optional route registrations.
      const existing = (config as UserConfig & { nitro?: { handlers?: { route?: string }[] } }).nitro?.handlers ?? []
      for (const kind of ['health', 'workspace'] as const) {
        const configured = options[kind]
        if (configured === undefined) continue
        const { exportName, route = kind === 'health' ? '/api/health' : agentHostWorkspaceRoute } = typeof configured === 'string' ? { exportName: configured } : configured
        if (!/^[$_\p{ID_Start}][$\u200C\u200D\p{ID_Continue}]*$/u.test(exportName))
          throw agentDiagnostics.AGENT_HOST_ROUTE_EXPORT_NAME_INVALID()
        if (!route.startsWith('/') || /[?#*]/.test(route) || (kind === 'workspace' && !route.split('/').includes(':id')))
          throw agentDiagnostics.AGENT_HOST_ROUTE_PATH_INVALID()
        if ([...existing, ...handlers].some(handler => handler.route === route))
          throw agentDiagnostics.AGENT_HOST_ROUTE_DUPLICATE({ route })
        const handler = resolve(directory, `${kind}-${createHash('sha256').update(JSON.stringify([entry, exportName, route])).digest('hex').slice(0, 16)}.ts`)
        const moduleImport = exportName === 'default'
          ? `import inspect from ${JSON.stringify(entry)}`
          : `import { ${exportName} as inspect } from ${JSON.stringify(entry)}`
        // Each route is a Fetchable module (https://fetchable.org), so any host that calls `fetch(request)` serves it.
        // The `:id` segment is counted from the end of the path, so a Nitro base URL before the route does not move it.
        const idFromEnd = route.split('/').length - route.split('/').indexOf(':id')
        const body = kind === 'health'
          ? `${moduleImport}\nexport default {\n  async fetch() {\n    const value = await inspect()\n    return value instanceof Response ? value : value === undefined ? new Response(null, { status: 204 }) : Response.json(value)\n  },\n}\n`
          : `${moduleImport}\nexport default {\n  fetch(request) {\n    const url = new URL(request.url)\n    const segments = url.pathname.replace(/\\/+$/, '').split('/')\n    const paths = url.searchParams.getAll('path')\n    return inspect(segments[segments.length - ${idFromEnd}] || '', paths.length === 1 ? paths[0] : undefined)\n  },\n}\n`
        await mkdir(directory, { recursive: true })
        await writeFile(handler, body)
        handlers.push({ route, handler, method: 'GET' }, { route, handler, method: 'HEAD' })
        if (kind === 'workspace') {
          const plugin = handler.replace(/\.ts$/, '-plugin.ts')
          await writeFile(plugin, `import { registerAgentHostWorkspaceInspector } from ${JSON.stringify(ownModule(import.meta.url, 'server'))}\n${moduleImport}\nexport default () => { registerAgentHostWorkspaceInspector(${JSON.stringify(route)}, inspect) }\n`)
          plugins.push(plugin)
        }
      }
      const result: UserConfig & { nitro: { handlers: typeof handlers, plugins: string[] } } = { nitro: { handlers, plugins } }
      return result
    },
  }
}
