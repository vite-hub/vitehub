import type { ViteHubCliContributor, ViteHubCliStreams } from "@vite-hub/internal/cli"

const rolesUsage = "vitehub cms roles [--json]"

function renderActions(actions: readonly string[] | undefined): string {
  return actions?.length ? actions.join(", ") : "-"
}

/** Prints each CMS role with its `content` and `comment` permissions. `--json` prints them as JSON. */
export async function runCmsRoles(args: readonly string[], streams: ViteHubCliStreams): Promise<number> {
  const unknown = args.find(arg => arg !== "--json")
  if (unknown !== undefined) {
    streams.stderr.write(`Unknown argument ${JSON.stringify(unknown)}. Usage: ${rolesUsage}\n`)
    return 1
  }
  // Better Auth loads only for this command, so other commands of an app without Auth do not need it.
  const { cmsRoles } = await import("./access.ts")
  const roles = Object.entries(cmsRoles).map(([name, role]) => ({
    name,
    content: [...role.statements.content ?? []],
    comment: [...role.statements.comment ?? []],
  }))
  if (args.includes("--json")) {
    streams.stdout.write(`${JSON.stringify({ roles }, null, 2)}\n`)
    return 0
  }
  const rows = [["Role", "Content", "Comments"], ...roles.map(role => [role.name, renderActions(role.content), renderActions(role.comment)])]
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map(row => row[column]!.length)))
  for (const row of rows) streams.stdout.write(`${row.map((cell, column) => cell.padEnd(widths[column]!)).join("  ").trimEnd()}\n`)
  streams.stdout.write([
    "",
    "Roles live in user.role of the Better Auth admin plugin, admin(cmsAccess). Several roles are separated by commas.",
    "New users get user, which has no CMS permission. admin also has every user and session permission of Better Auth.",
    "Change a role with auth.api.setRole() or in the Console Auth section.",
    "",
  ].join("\n"))
  return 0
}

/** The `vitehub cms` commands. */
export function createCmsCliContributor(): ViteHubCliContributor {
  return {
    namespaces: [{
      defaultFeature: "roles",
      description: "Inspect the CMS roles and their permissions.",
      features: [{
        description: "List each CMS role with the Content and Comments actions it allows.",
        name: "roles",
        run: async (args, context) => await runCmsRoles(args, context),
        usage: rolesUsage,
      }],
      name: "cms",
    }],
  }
}
