export interface ViteStageServer {
  close: () => Promise<void>
  config: { envDir: string | false, root: string }
}

export interface ViteStageServerConfig {
  appType: "custom"
  logLevel: "silent"
  mode: string
  root: string
  server: { hmr: false, middlewareMode: true }
}

export interface ViteStageModule<TServer extends ViteStageServer> {
  createServer: (config: ViteStageServerConfig) => Promise<TServer>
  loadEnv: (mode: string, envDir: string | false, prefixes: string) => Record<string, string>
}

export interface ViteStageServerInput {
  /** Environment that wins over values from stage-specific env files. */
  env: NodeJS.ProcessEnv
  rootDir: string
  stage: string
}

type QueueCarrier = typeof globalThis & { [viteStageQueueKey]?: Promise<void> }

// Packages bundle this module separately, so the process-wide queue lives on globalThis.
const viteStageQueueKey = Symbol.for("vitehub.cli.vite-stage-queue")

function definedEntries(env: NodeJS.ProcessEnv): Array<[string, string]> {
  return Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)
}

function replaceProcessEnv(entries: Iterable<[string, string]>): void {
  for (const key of Object.keys(process.env)) delete process.env[key]
  for (const [key, value] of entries) process.env[key] = value
}

async function runExclusive<TServer extends ViteStageServer, TResult>(
  vite: ViteStageModule<TServer>,
  input: ViteStageServerInput,
  callback: (server: TServer) => Promise<TResult>,
): Promise<TResult> {
  let server: TServer | undefined
  const previousEnvironment = definedEntries(process.env)
  const selectedEnvironment = definedEntries(input.env)
  try {
    replaceProcessEnv(selectedEnvironment)
    server = await vite.createServer({
      appType: "custom",
      logLevel: "silent",
      mode: input.stage,
      root: input.rootDir,
      server: { hmr: false, middlewareMode: true },
    })
    // Keep values that Vite set during startup, such as NODE_ENV.
    for (const [key, value] of [...Object.entries(vite.loadEnv(input.stage, server.config.envDir, "")), ...selectedEnvironment]) {
      process.env[key] = value
    }
    return await callback(server)
  }
  finally {
    try {
      await server?.close()
    }
    finally {
      replaceProcessEnv(previousEnvironment)
    }
  }
}

/**
 * Run a CLI operation against a Vite Development Server in the selected stage mode.
 *
 * During the callback, `process.env` contains the stage-specific Vite env files
 * (`.env`, `.env.local`, `.env.<stage>`, `.env.<stage>.local`) with `input.env`
 * taking precedence. The previous `process.env` is restored afterwards. Calls run
 * one at a time because `process.env` is process-wide.
 */
export async function withViteStageServer<TServer extends ViteStageServer, TResult>(
  vite: ViteStageModule<TServer>,
  input: ViteStageServerInput,
  callback: (server: TServer) => Promise<TResult>,
): Promise<TResult> {
  const carrier: QueueCarrier = globalThis
  const previous = carrier[viteStageQueueKey] ?? Promise.resolve()
  let release!: () => void
  carrier[viteStageQueueKey] = new Promise<void>((resolve) => {
    release = resolve
  })
  await previous
  try {
    return await runExclusive(vite, input, callback)
  }
  finally {
    release()
  }
}
