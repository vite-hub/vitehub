// Shared by the build and the browser, so this file imports nothing from Node.
import type { WorkspaceRenderContext, WorkspaceRenderResult } from "@vite-hub/ui/workspace"
import type { ConnectProviderName } from "@vite-hub/web-container/connect"
import type { Component } from "vue"

/** Text files of an app, keyed by a relative path such as `server/api/greet.post.ts`. */
export type TutorialFiles = Record<string, string>

/** Binary files of an app, such as model weights, keyed by a relative path. */
export type TutorialAssets = Record<string, Uint8Array>

export interface RunnableTutorialStep {
  /** The `::tutorial-step` title. */
  title: string
  /** The files that this step writes, with their final contents from the fixture. */
  files: TutorialFiles
}

/** What the workspace of one tutorial mounts, built from its lesson page and its fixture. */
export interface RunnableTutorialData {
  slug: string
  /** The docs page that holds the lesson prose. */
  page: string
  title: string
  description: string
  /** The files before step 1: the fixture without the files that the steps write, with the fixture's dependencies. */
  files: TutorialFiles
  steps: RunnableTutorialStep[]
  /** The parts of the `node_modules` snapshot and their SHA-256, for `fetchSnapshot()`. Without it, the workspace runs `npm install`. */
  snapshot?: { parts: string[], sha256: string }
}

/** A starting app of `/playground`, read from a fixture. */
export interface PlaygroundTemplate {
  id: string
  label: string
  description?: string
  /** The heading of the example in the examples menu. */
  group?: string
  /** The file that the editor opens first. */
  open?: string
  /** The path that the preview opens when the dev server is ready. */
  preview?: string
  /** The paths of `files` that the editor does not let the reader change. */
  readonly?: string[]
  files: TutorialFiles
  /**
   * The files that are not valid UTF-8, such as model weights. The page module of a `playground` page carries them.
   * `#build/playground-templates.mjs` leaves them out.
   */
  assets?: TutorialAssets
  /** The slug of the snapshot that this template mounts. Templates with the same dependencies share one. */
  snapshotOf: string
  /** The parts of that snapshot and their SHA-256, for `fetchSnapshot()`. Without it, the workspace runs `npm install`. */
  snapshot?: RunnableTutorialData["snapshot"]
}

/** An example of a `playground` page. Examples with the same `snapshotOf` mount one snapshot. A `render` page has none. */
export type DocsPlaygroundExampleData = Omit<PlaygroundTemplate, "snapshotOf"> & { snapshotOf?: string }

/** What the page module of a `playground` page holds, besides its loaders. */
export interface DocsPlaygroundData {
  layout: "playground"
  examples: DocsPlaygroundExampleData[]
  /** Without `render`: the port of the dev server. */
  port: number
  /** Without `render`: the accounts that the reader can connect. */
  connect?: ConnectProviderName[]
}

/** What the page module of a `learn` page holds. */
export interface DocsLearnData {
  layout: "learn"
  tutorial: RunnableTutorialData
  guide: "top" | "side"
  port: number
  preview?: string
}

/**
 * The default export of the `render` module of a `layout: playground` page. It gets the text files, and the open
 * example with its binary files in `example.assets`.
 */
export type DocsRenderFunction = (files: TutorialFiles, context: WorkspaceRenderContext) => WorkspaceRenderResult | Promise<WorkspaceRenderResult>

/** An output tab of a `layout: playground` page, with the component that draws it. */
export interface DocsWorkspaceTab {
  value: string
  label: string
  component: () => Promise<{ default: Component }>
}

/** The workspace of a `playground` or `learn` page, as `#build/docs/workspaces.mjs` loads it by page path. */
export type DocsWorkspaceData =
  | (DocsPlaygroundData & { render?: () => Promise<{ default: DocsRenderFunction }>, tabs?: DocsWorkspaceTab[] })
  | DocsLearnData

/** The files at the start of step `index` (from 0), or at its end with `solution`. Each step builds on the one before. */
export function tutorialStepFiles(tutorial: Pick<RunnableTutorialData, "files" | "steps">, index: number, state: "start" | "solution"): TutorialFiles {
  const last = state === "solution" ? index : index - 1
  const files = { ...tutorial.files }
  for (let step = 0; step <= last && step < tutorial.steps.length; step++) Object.assign(files, tutorial.steps[step]!.files)
  return files
}

/** Loads a lesson state, removing absent tutorial files while keeping unrelated reader additions. */
export function tutorialWorkspaceFiles(tutorial: Pick<RunnableTutorialData, "files" | "steps">, current: TutorialFiles, target: TutorialFiles): TutorialFiles {
  const owned = new Set([...Object.keys(tutorial.files), ...tutorial.steps.flatMap(step => Object.keys(step.files))])
  const next = { ...current }
  for (const path of owned) {
    if (!(path in target)) delete next[path]
  }
  return Object.assign(next, target)
}

// Nitro looks for `index.html` once per process and caches a miss, so a Vite restart in the same process does not find
// a new page. Vite restarts on its own when `vite.config.*` changes, which is enough for config edits.
// Remove when Nitro releases https://github.com/nitrojs/nitro/pull/5037 (https://github.com/nitrojs/nitro/issues/5038).
const startFiles = ["index.html"]

/** Whether going from `before` to `after` adds or removes a file that the dev server reads only when its process starts. */
export function restartsDevServer(before: TutorialFiles, after: TutorialFiles): boolean {
  return startFiles.some(path => (path in before) !== (path in after))
}

/** The `dependencies` of a `package.json`, sorted, so two apps with the same install compare equal. Invalid JSON has its own key. */
export function dependencyKey(packageJson: string | undefined): string {
  try {
    const dependencies: unknown = packageJson ? JSON.parse(packageJson).dependencies : undefined
    const entries = dependencies && typeof dependencies === "object" ? Object.entries(dependencies) : []
    return JSON.stringify(entries.sort(([a], [b]) => a.localeCompare(b)))
  }
  catch {
    return "invalid"
  }
}
