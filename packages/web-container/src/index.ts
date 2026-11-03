import type { FileSystemAPI, FileSystemTree, WebContainer as StackBlitzWebContainer } from "@webcontainer/api"

export type { FileSystemAPI, FileSystemTree } from "@webcontainer/api"

/** One step of a boot checklist, in the order a UI shows it. */
export type WebContainerStage =
  | "checking"
  | "unsupported"
  | "booting"
  | "mounting"
  | "installing"
  | "starting"
  | "ready"
  | "error"

export interface WebContainerStep {
  stage: WebContainerStage
  /** `performance.now()` when the stage started. */
  startedAt: number
  /** Milliseconds the stage took. Unset while the stage runs. */
  ms?: number
}

export interface WebContainerStatus {
  /** The latest stage. */
  stage: WebContainerStage
  /** Every stage so far, with its timing. */
  steps: readonly WebContainerStep[]
  /** Set when `stage` is `unsupported` or `error`. */
  error?: Error
}

/** Files to mount, keyed by a relative path such as `server/index.js`. */
export type WebContainerFiles = Record<string, string | Uint8Array>

export interface BootWebContainerOptions {
  /** Files to write into the working directory. */
  files?: WebContainerFiles
  /** A binary snapshot from `container.export()`, such as an app with `node_modules` already installed. Mounted before `files`. */
  snapshot?: Uint8Array | ArrayBuffer
  /**
   * The Cross-Origin-Embedder-Policy of the page.
   * @default "credentialless"
   */
  coep?: "credentialless" | "require-corp"
  /** Folder name of the working directory. */
  workdirName?: string
  /** Called on every status change, from the first check on. */
  onStatus?: (status: WebContainerStatus) => void
}

/** `install`, `dev`, and `build` run the npm scripts of the mounted app. An array runs that command line. */
export type WebContainerCommand = "install" | "dev" | "build" | readonly [string, ...string[]]

export interface WebContainerRunOptions {
  /** Environment variables for this process only. They stay in the browser tab. */
  env?: Record<string, string>
  /** Working directory, relative to the container root. */
  cwd?: string
  /** Kills the process when aborted. */
  signal?: AbortSignal
}

export interface WebContainerRun {
  /** Terminal output of the process and its children. Read it once. Buffers up to 65,536 characters; excess output is dropped until the reader catches up. */
  output: ReadableStream<string>
  /** Resolves with the exit code. */
  exit: Promise<number>
  /** Resolves with the last 65,536 characters of output after the process exits. */
  text: () => Promise<string>
  /** Writes to the process stdin. */
  write: (input: string) => Promise<void>
  kill: () => void
}

export interface WebContainerPreviewServer {
  url: string
  port: number
}

export interface WebContainerPreview {
  /** The URL of the latest server that became ready. */
  readonly url: string | undefined
  readonly port: number | undefined
  /** Resolves when the first server becomes ready; rejects on startup failure or teardown before readiness. The port is the one the WebContainer picks, not always the one the app asks for. */
  ready: Promise<WebContainerPreviewServer>
}

export interface ViteHubWebContainer {
  readonly status: WebContainerStatus
  preview: WebContainerPreview
  fs: FileSystemAPI
  /** Only one `dev` run may be active. Stop it and await its exit before starting another. */
  run: (command: WebContainerCommand, options?: WebContainerRunOptions) => Promise<WebContainerRun>
  /** Serializes the working directory to a binary snapshot that `bootWebContainer({ snapshot })` mounts. */
  export: (options?: { path?: string, excludes?: string[], includes?: string[] }) => Promise<Uint8Array>
  on: (event: "status", listener: (status: WebContainerStatus) => void) => () => void
  /** Stops every process and frees the container. Boot a new one afterwards if needed. */
  teardown: () => void
}

export type WebContainerSupport =
  | { supported: true }
  | { supported: false, reason: string }

export class WebContainerUnsupportedError extends Error {
  override name: string = "WebContainerUnsupportedError"
}

/** Checks the page, not the browser name: a WebContainer needs a cross-origin isolated page with SharedArrayBuffer. */
export function checkWebContainerSupport(): WebContainerSupport {
  if (Reflect.get(globalThis, "document") === undefined) return { supported: false, reason: "WebContainers run in a browser page, not on the server." }
  if (Reflect.get(globalThis, "crossOriginIsolated") !== true) {
    return {
      supported: false,
      reason: "The page is not cross-origin isolated. Serve it with Cross-Origin-Opener-Policy: same-origin and Cross-Origin-Embedder-Policy: credentialless (see @vite-hub/web-container/vite).",
    }
  }
  if (typeof SharedArrayBuffer === "undefined") return { supported: false, reason: "This browser has no SharedArrayBuffer." }
  return { supported: true }
}

const commandLines = {
  install: ["npm", "install", "--no-audit", "--no-fund", "--no-progress"],
  dev: ["npm", "run", "dev"],
  build: ["npm", "run", "build"],
} as const

const commandStages: Partial<Record<string, WebContainerStage>> = { install: "installing", dev: "starting" }

/** Turns `{ "server/index.js": "..." }` into the nested tree that WebContainer mounts. */
export function toFileSystemTree(files: WebContainerFiles): FileSystemTree {
  const root: FileSystemTree = {}
  for (const [path, contents] of Object.entries(files)) {
    const segments = path.split("/")
    if (path.startsWith("/") || segments.includes("..")) throw new TypeError(`Invalid WebContainer file path: ${path}`)
    const parts = segments.filter(part => part && part !== ".")
    const name = parts.pop()
    if (!name) throw new TypeError(`Invalid WebContainer file path: ${path}`)
    let tree = root
    for (const part of parts) {
      let node = Object.hasOwn(tree, part) ? tree[part] : undefined
      if (!node) {
        node = { directory: {} }
        Object.defineProperty(tree, part, { value: node, enumerable: true, configurable: true, writable: true })
      }
      if (!("directory" in node)) throw new TypeError(`WebContainer path ${path} goes through the file ${part}.`)
      tree = node.directory
    }
    if (Object.hasOwn(tree, name) && "directory" in tree[name]) throw new TypeError(`WebContainer path ${path} replaces the directory ${name}.`)
    Object.defineProperty(tree, name, { value: { file: { contents } }, enumerable: true, configurable: true, writable: true })
  }
  return root
}

function createStatusTracker(onStatus?: (status: WebContainerStatus) => void) {
  const listeners = new Set<(status: WebContainerStatus) => void>()
  if (onStatus) listeners.add(onStatus)
  const steps: WebContainerStep[] = []
  let status: WebContainerStatus = { stage: "checking", steps }

  function finishOpenStep() {
    const open = steps.at(-1)
    if (open && open.ms === undefined) open.ms = performance.now() - open.startedAt
  }

  function emit(next: WebContainerStatus) {
    status = next
    for (const listener of listeners) listener(status)
  }

  return {
    get current() { return status },
    listeners,
    enter(stage: WebContainerStage) {
      finishOpenStep()
      steps.push({ stage, startedAt: performance.now() })
      emit({ stage, steps: [...steps] })
    },
    finish(stage: WebContainerStage) {
      const open = steps.at(-1)
      if (open?.stage !== stage || open.ms !== undefined) return
      finishOpenStep()
      emit({ ...status, steps: [...steps] })
    },
    fail(stage: "unsupported" | "error", error: Error) {
      finishOpenStep()
      steps.push({ stage, startedAt: performance.now(), ms: 0 })
      emit({ stage, steps: [...steps], error })
    },
  }
}

const outputLimit = 64 * 1024

function wrapProcess(spawned: Awaited<ReturnType<StackBlitzWebContainer["spawn"]>>, signal?: AbortSignal): WebContainerRun {
  let captured = ""
  let outputCancelled = false
  let outputController!: ReadableStreamDefaultController<string>
  const output = new ReadableStream<string>({
    start(controller) { outputController = controller },
    cancel() { outputCancelled = true },
  }, { highWaterMark: outputLimit, size: chunk => chunk.length })
  // Drain the process even when the terminal is idle, without tee()'s unbounded queue.
  const collected = spawned.output.pipeTo(new WritableStream<string>({
    write(chunk) {
      captured = (captured + chunk).slice(-outputLimit)
      const available = outputController.desiredSize ?? 0
      if (!outputCancelled && available > 0 && chunk.length > 0) outputController.enqueue(chunk.slice(0, available))
    },
    close() { if (!outputCancelled) outputController.close() },
    abort(error) { if (!outputCancelled) outputController.error(error) },
  })).catch(() => {})
  const kill = () => spawned.kill()
  signal?.addEventListener("abort", kill, { once: true })
  if (signal?.aborted) kill()
  const exit = spawned.exit.finally(() => signal?.removeEventListener("abort", kill))
  return {
    output,
    exit,
    kill,
    async text() {
      await exit
      await collected
      return captured
    },
    async write(input) {
      const writer = spawned.input.getWriter()
      try { await writer.write(input) }
      finally { writer.releaseLock() }
    },
  }
}

/**
 * Boots a WebContainer in this browser tab and mounts an app into it.
 *
 * Only one WebContainer can run per page. Call `teardown()` before you boot another.
 */
export async function bootWebContainer(options: BootWebContainerOptions = {}): Promise<ViteHubWebContainer> {
  const status = createStatusTracker(options.onStatus)
  status.enter("checking")
  const support = checkWebContainerSupport()
  if (!support.supported) {
    const error = new WebContainerUnsupportedError(support.reason)
    status.fail("unsupported", error)
    throw error
  }

  let booted: StackBlitzWebContainer | undefined
  try {
    status.enter("booting")
    const { WebContainer } = await import("@webcontainer/api")
    booted = await WebContainer.boot({ coep: options.coep ?? "credentialless", workdirName: options.workdirName })
    if (options.snapshot || options.files) {
      status.enter("mounting")
      if (options.snapshot) await booted.mount(options.snapshot)
      if (options.files) await booted.mount(toFileSystemTree(options.files))
    }
    status.finish(status.current.stage)
  }
  catch (cause) {
    const error = cause instanceof Error ? cause : new Error(String(cause))
    booted?.teardown()
    status.fail("error", error)
    throw error
  }
  const container = booted

  let server: WebContainerPreviewServer | undefined
  let resolveReady!: (server: WebContainerPreviewServer) => void
  let rejectReady!: (error: Error) => void
  let readySettled = false
  let serverReadyCount = 0
  let devRunning = false
  const ready = new Promise<WebContainerPreviewServer>((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
  // Readiness is optional: consumers may use status events without awaiting it.
  void ready.catch(() => {})
  function rejectPendingReady(error: Error) {
    if (readySettled) return
    readySettled = true
    rejectReady(error)
  }
  function fail(error: Error) {
    rejectPendingReady(error)
    status.fail("error", error)
  }
  container.on("server-ready", (port, url) => {
    serverReadyCount++
    server = { port, url }
    if (!readySettled) {
      readySettled = true
      resolveReady(server)
    }
    if (status.current.stage === "starting") status.enter("ready")
  })
  container.on("error", ({ message }) => fail(new Error(message)))

  return {
    get status() { return status.current },
    preview: {
      get url() { return server?.url },
      get port() { return server?.port },
      ready,
    },
    fs: container.fs,
    async run(command, runOptions = {}) {
      const [file, ...args] = typeof command === "string" ? commandLines[command] : command
      const stage = typeof command === "string" ? commandStages[command] : undefined
      if (stage === "starting") {
        if (devRunning) throw new Error("A dev process is already running. Stop it and await its exit before starting another.")
        // Reserve the slot before spawn yields so an overlapping call cannot share readiness.
        devRunning = true
      }
      const readyCountAtStart = serverReadyCount
      if (stage) status.enter(stage)
      let spawned: Awaited<ReturnType<StackBlitzWebContainer["spawn"]>>
      try {
        spawned = await container.spawn(file, args, { cwd: runOptions.cwd, env: runOptions.env })
      }
      catch (cause) {
        const error = cause instanceof Error ? cause : new Error(String(cause))
        if (stage === "starting") devRunning = false
        if (stage) fail(error)
        throw error
      }
      const run = wrapProcess(spawned, runOptions.signal)
      if (stage === "installing") {
        void run.exit.then(async (code) => {
          if (code === 0) return status.finish("installing")
          fail(new Error(`npm install exited with code ${code}.\n${(await run.text()).slice(-2000)}`))
        })
      }
      if (stage === "starting") {
        void run.exit.then((code) => {
          devRunning = false
          if (serverReadyCount === readyCountAtStart) fail(new Error(`The dev server exited with code ${code} before it was ready.`))
        })
      }
      return run
    },
    export(exportOptions = {}) {
      const { path = ".", ...rest } = exportOptions
      return container.export(path, { ...rest, format: "binary" })
    },
    on(_event, listener) {
      status.listeners.add(listener)
      return () => status.listeners.delete(listener)
    },
    teardown() {
      rejectPendingReady(new Error("The WebContainer was torn down before the preview was ready."))
      status.listeners.clear()
      container.teardown()
    },
  }
}
