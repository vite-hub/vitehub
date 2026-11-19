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
  { from: ["agents", "list"], now: "vitehub agent list" },
  { from: ["agents", "invoke"], now: "vitehub agent invoke" },
  { from: ["agents", "status"], now: "vitehub agent get <name>", migration: "Pass the Agent name instead of --agent and select the Console app with --url." },
  { from: ["conversations", "export"], now: "vitehub agent conversations export" },
  { from: ["invocations", "list"], now: "vitehub agent invocations list", migration: "Check --help for supported filters; the CLI JSON no longer includes a Console cursor." },
  { from: ["invocations", "get"], now: "vitehub agent invocations get", migration: "Pass the Invocation ID; JSON is a flat record, and observation paging options are no longer supported by the CLI." },
  { from: ["invocations", "cancel"], now: "vitehub agent invocations cancel", migration: "Pass the Invocation ID and --url <app> to use the same Console." },
  { from: ["invocations", "undo"], now: "vitehub agent invocations undo", migration: "Pass the Invocation ID, --change <id>, and --url <app>." },
  { from: ["invocations", "delete"], now: "vitehub agent invocations delete", migration: "Pass the Invocation ID and --url <app> to delete from the same Console. Without --url this deletes from the journal file." },
  { from: ["invocations", "capabilities"], now: "vitehub agent invocations capabilities" },
  { from: ["invocations", "workspace"], now: "vitehub agent invocations workspace" },
  { from: ["agent", "info"], now: "vitehub agent get", migration: "Pass the name instead of --agent and use --server for an explicit Dev Loop URL." },
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
