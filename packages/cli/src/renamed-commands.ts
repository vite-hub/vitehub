/**
 * Commands that ViteHub renamed or removed. The old spelling does not run: it fails with the command to use, before the
 * project config loads. `vitehub migrate` rewrites the old spellings in scripts and CI.
 */
interface RenamedCommand {
  /** The old command words, such as `["content", "show"]`. */
  from: readonly string[]
  /** The command to run now, such as `vitehub content get`. */
  now: string
  /** Matches only when the word after `from` passes, such as `schedule runs <id>` without `list` or `get`. */
  next?: (word: string | undefined) => boolean
}

const renamedCommands: readonly RenamedCommand[] = [
  { from: ["agents", "list"], now: "vitehub agent list" },
  { from: ["agents", "invoke"], now: "vitehub agent invoke" },
  { from: ["agents", "status"], now: "vitehub agent get <name>" },
  { from: ["conversations", "export"], now: "vitehub agent conversations export" },
  { from: ["invocations", "list"], now: "vitehub agent invocations list" },
  { from: ["invocations", "get"], now: "vitehub agent invocations get" },
  { from: ["invocations", "cancel"], now: "vitehub agent invocations cancel" },
  { from: ["invocations", "undo"], now: "vitehub agent invocations undo" },
  { from: ["invocations", "delete"], now: "vitehub agent invocations delete" },
  { from: ["invocations", "capabilities"], now: "vitehub agent invocations capabilities" },
  { from: ["invocations", "workspace"], now: "vitehub agent invocations workspace" },
  { from: ["agent", "info"], now: "vitehub agent get" },
  { from: ["agent", "invocations", "show"], now: "vitehub agent invocations get" },
  { from: ["content", "show"], now: "vitehub content get" },
  { from: ["definitions", "list"], now: "vitehub inspect definitions" },
  { from: ["email", "outbox", "show"], now: "vitehub email outbox get" },
  { from: ["env", "inspect"], now: "vitehub env list" },
  { from: ["env", "status"], now: "vitehub env list --url <app>" },
  { from: ["project", "info"], now: "vitehub project get" },
  { from: ["queue", "jobs", "show"], now: "vitehub queue jobs get" },
  { from: ["schedule", "attempts"], now: "vitehub schedule runs get <run>" },
  { from: ["schedule", "runs"], next: word => word !== undefined && !["get", "list", "-h", "--help"].includes(word), now: "vitehub schedule runs list <schedule>" },
  { from: ["workflow", "get"], now: "vitehub workflow runs get" },
  { from: ["workflow", "runs", "show"], now: "vitehub workflow runs get" },
  { from: ["workspace", "show"], now: "vitehub workspace get" },
]

/** The message for an old command spelling, or undefined when `args` is a current command. */
export function renamedCommandMessage(args: readonly string[]): string | undefined {
  const renamed = renamedCommands.find(entry => entry.from.every((word, index) => args[index] === word) && (entry.next?.(args[entry.from.length]) ?? true))
  if (!renamed) return
  return `[vitehub] \`vitehub ${renamed.from.join(" ")}\` is now \`${renamed.now}\`. Run \`${renamed.now}\` with the same arguments. \`vitehub migrate\` changes it in package.json scripts and CI files.`
}
