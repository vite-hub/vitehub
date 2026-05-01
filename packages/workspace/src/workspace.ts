import { WorkspaceError } from "./errors.ts"
import { createWorkspaceStore, syncWorkspaceDefinition } from "./lifecycle.ts"
import type {
  ExecOptions,
  ExecResult,
  ReadFileOptions,
  Workspace,
  WorkspaceContent,
  WorkspaceDefinition,
  WorkspaceMount,
  WorkspaceMountOptions,
  WorkspaceSession,
  WorkspaceStore,
} from "./types.ts"

const storeByDefinition = new WeakMap<WorkspaceDefinition, WorkspaceStore>()

function getStore(definition: WorkspaceDefinition) {
  let store = storeByDefinition.get(definition)
  if (!store) {
    store = createWorkspaceStore(definition)
    storeByDefinition.set(definition, store)
  }
  return store
}

function decodeFile(content: WorkspaceContent, options?: ReadFileOptions) {
  if (options?.encoding === "binary") return content
  return typeof content === "string" ? content : new TextDecoder().decode(content)
}

function execLocal(command: string, args: string[] = [], options: ExecOptions = {}): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    import("node:child_process").then(({ spawn }) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on("data", chunk => stdout.push(Buffer.from(chunk)))
    child.stderr.on("data", chunk => stderr.push(Buffer.from(chunk)))
    child.on("error", reject)
    child.on("close", code => resolve({
      command,
      args,
      exitCode: code ?? 0,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    }))
    }).catch(reject)
  })
}

export function createWorkspace(definition: WorkspaceDefinition): Workspace {
  const store = getStore(definition)

  const workspace: Workspace = {
    name: definition.name,
    async sync() {
      await syncWorkspaceDefinition(definition, store)
    },
    async readFile(path, options) {
      const file = await store.readFile(path)
      if (!file) throw new WorkspaceError(`[vitehub] Workspace file does not exist: ${path}.`)
      return decodeFile(file.content, options)
    },
    async writeFile(path, content, options) {
      await store.writeFile(path, { path, content, mediaType: options?.mediaType })
    },
    async list(path, options) {
      return await store.list(path, options)
    },
    async glob(pattern, options) {
      return await store.glob(pattern, options)
    },
    async stat(path) {
      const result = await store.stat(path)
      if (!result) throw new WorkspaceError(`[vitehub] Workspace path does not exist: ${path}.`)
      return result
    },
    async exists(path) {
      return Boolean(await store.stat(path))
    },
    async mkdir(path, options) {
      await store.mkdir(path, options)
    },
    async rm(path, options) {
      await store.rm(path, options)
    },
    async snapshot(options) {
      return await store.snapshot(options)
    },
    async diff(options) {
      return await store.diff(options)
    },
    async open(): Promise<WorkspaceSession> {
      return {
        readFile: workspace.readFile,
        writeFile: workspace.writeFile,
        list: workspace.list,
        glob: workspace.glob,
        diff: workspace.diff,
        exec: execLocal,
      }
    },
    mount(options?: WorkspaceMountOptions): WorkspaceMount {
      const mode = options?.mode || "read-only"
      return {
        workspace,
        mode,
        target: options?.target || "/workspace",
        async diff() {
          return await workspace.diff()
        },
        async commit() {
          await workspace.snapshot({ name: "mount-commit" })
        },
        async export() {
          return await workspace.snapshot({ name: "mount-export" })
        },
      }
    },
  }

  return workspace
}
