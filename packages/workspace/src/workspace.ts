import { WorkspaceError } from "./errors.ts"
import { createWorkspaceStore, syncWorkspaceDefinition } from "./lifecycle.ts"
import type {
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
    async open(options): Promise<WorkspaceSession> {
      const session: WorkspaceSession = {
        readFile: workspace.readFile,
        writeFile: workspace.writeFile,
        list: workspace.list,
        glob: workspace.glob,
        diff: workspace.diff,
      }
      if (options?.runtime === "local") {
        const { execLocal } = await import("./runtimes/local.ts")
        session.exec = execLocal
      }
      return session
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
