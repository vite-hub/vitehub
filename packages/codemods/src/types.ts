/** A manual step that the codemod could not do safely. */
export interface FollowUp {
  /** Path relative to the project directory. */
  file?: string
  /** 1-based line in `file`. */
  line?: number
  message: string
}

/** The planned content of one file. `before` is `undefined` for a new file, and `after` is `null` for a deleted file. */
export interface FileEdit {
  /** Path relative to the project directory. */
  path: string
  before: string | undefined
  after: string | null
}

export interface CodemodResult {
  /** One line that tells what the codemod did. */
  summary: string
  edits: FileEdit[]
  followUps: FollowUp[]
  /** Facts about the migration that need no action in a specific file. */
  notes: string[]
  /** Commands to run after the codemod, such as an install. */
  nextSteps: string[]
}

export interface CodemodContext {
  /** Absolute path of the project directory. */
  cwd: string
  /** Original project directory for read-only installed dependency inspection when cwd is a scratch copy. */
  dependencyRoot?: string
}

/** Why a codemod applies to a project, such as "nuxt.config.ts lists nuxt-safe-runtime-config". */
export interface Detection {
  reason: string
}

export interface Codemod {
  name: string
  /** One line for the codemod list. */
  description: string
  /** Positional arguments after the codemod name, for help output. */
  usage: string
  /** Tells whether the project uses what this codemod migrates. It must be cheap and must not throw for a project that does not use it. */
  detect: (context: CodemodContext) => Promise<Detection | undefined>
  /** Plans the edits. It must not write files; the runner writes them. */
  run: (context: CodemodContext) => Promise<CodemodResult>
}

/** A codemod cannot migrate the project. The CLI prints the message and exits with code 1. */
export class CodemodError extends Error {
  override name = "CodemodError"
}
