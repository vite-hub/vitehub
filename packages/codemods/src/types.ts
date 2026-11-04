/** A manual step that the codemod could not do safely. */
export interface FollowUp {
  /** Path relative to the project directory. */
  file?: string
  /** 1-based line in `file`. */
  line?: number
  message: string
}

/** The planned content of one file. `before` is `undefined` for a new file. */
export interface FileEdit {
  /** Path relative to the project directory. */
  path: string
  before: string | undefined
  after: string
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
}

export interface Codemod {
  name: string
  /** One line for the codemod list. */
  description: string
  /** Positional arguments after the codemod name, for help output. */
  usage: string
  /** Plans the edits. It must not write files; the runner writes them. */
  run: (context: CodemodContext) => Promise<CodemodResult>
}

/** A codemod cannot migrate the project. The CLI prints the message and exits with code 1. */
export class CodemodError extends Error {
  override name = "CodemodError"
}
