/**
 * Commands that ViteHub renamed or removed. The old spelling does not run: it fails with the command to use, before the
 * project config loads. `vitehub migrate` rewrites the old spellings in scripts and CI.
 */
interface RenamedCommand {
  /** The old command words, such as `["content", "show"]`. */
  from: readonly string[]
  /** The command to run now, such as `vitehub content get`. */
  now: string
  migration?: string
  /** Matches only when the word after `from` passes, such as `schedule runs <id>` without `list` or `get`. */
  next?: (word: string | undefined) => boolean
}

const renamedCommands: readonly RenamedCommand[] = [
  { from: ["agent", "info"], now: "vitehub agent get" },
  { from: ["agent", "invocations", "show"], now: "vitehub agent invocations get" },
  { from: ["content", "show"], now: "vitehub content get" },
  { from: ["definitions", "list"], now: "vitehub inspect definitions", migration: "Use --kind <kind> for local definitions, or the Console for runtime records. The old section and URL arguments do not carry over." },
  { from: ["email", "outbox", "show"], now: "vitehub email outbox get" },
  { from: ["env", "inspect"], now: "vitehub env list" },
  { from: ["env", "status"], now: "vitehub env list --url <app>", migration: "Pass the running app URL explicitly and add --json to keep JSON output. Review --input or --timeout manually; env list does not accept them." },
  { from: ["project", "info"], now: "vitehub project get" },
  { from: ["queue", "jobs", "show"], now: "vitehub queue jobs get" },
  { from: ["schedule", "attempts"], now: "vitehub schedule runs get <run>" },
  { from: ["schedule", "runs"], next: word => word !== undefined && !["get", "list", "-h", "--help"].includes(word), now: "vitehub schedule runs list <schedule>" },
  { from: ["workflow", "get"], now: "vitehub workflow runs get", migration: "Add --json to keep JSON output." },
  { from: ["workflow", "runs", "show"], now: "vitehub workflow runs get", migration: "Use --run-id instead of --id, and runId instead of id in --input JSON." },
  { from: ["workspace", "show"], now: "vitehub workspace get" },
]

/** The message for an old command spelling, or undefined when `args` is a current command. */
export function renamedCommandMessage(args: readonly string[]): string | undefined {
  const renamed = renamedCommands.find(entry => entry.from.every((word, index) => args[index] === word) && (entry.next?.(args[entry.from.length]) ?? true))
  if (!renamed) return
  return `[vitehub] \`vitehub ${renamed.from.join(" ")}\` is now \`${renamed.now}\`. ${renamed.migration ? `${renamed.migration} ` : ""}\`vitehub migrate\` updates compatible calls and reports manual steps in scripts and CI files.`
}
