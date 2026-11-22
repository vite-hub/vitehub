import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import ts from "typescript"
import { describe, expect, it } from "vitest"

import { packageDir, packageInfos, readPackageManifest } from "./utils/repo"

interface OwnerEntry {
  specifier: string
  source: string
}

// The public entries of each package, with their source file. `internal/*` entries are for ViteHub packages only.
function publicOwnerEntries(): OwnerEntry[] {
  return packageInfos.flatMap((info) => {
    const exports = readPackageManifest(info.name).exports ?? {}
    return Object.entries(exports).flatMap(([subpath, target]) => {
      if (subpath === "./package.json" || /(?:^|\/)_?internal(?:\/|$)/.test(subpath)) return []
      const file = typeof target === "string" ? target : typeof target.import === "string" ? target.import : target.default
      if (typeof file !== "string" || !file.startsWith("./dist/")) return []
      const base = file.slice("./dist/".length).replace(/\.m?js$/, "")
      const source = [".ts", ".mts", ".tsx"].map(extension => join(packageDir(info.name), "src", `${base}${extension}`)).find(existsSync)
      return source ? [{ specifier: `${info.packageName}${subpath.slice(1)}`, source }] : []
    })
  })
}

function relativeStarExports(source: string): string[] {
  return [...readFileSync(source, "utf8").matchAll(/^export\s+\*\s+from\s+["'](\.{1,2}\/[^"']+)["']/gm)].map(match => match[1]!)
}

// The value names that an entry exports. Types are not autocomplete noise in value position, so they are not listed.
function valueExports(source: string): string[] {
  const file = ts.createSourceFile(source, readFileSync(source, "utf8"), ts.ScriptTarget.Latest)
  const names: string[] = []
  const exported = (node: ts.Node) => ts.canHaveModifiers(node) && ts.getModifiers(node)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)
  for (const statement of file.statements) {
    if (ts.isExportDeclaration(statement)) {
      if (statement.isTypeOnly) continue
      if (!statement.exportClause) throw new Error(`${source} has an unnamed export *`)
      if (ts.isNamespaceExport(statement.exportClause)) names.push(statement.exportClause.name.text)
      else for (const element of statement.exportClause.elements) if (!element.isTypeOnly) names.push(element.name.text)
    }
    else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement)) && exported(statement) && statement.name) {
      names.push(statement.name.text)
    }
    else if (ts.isVariableStatement(statement) && exported(statement)) {
      for (const declaration of statement.declarationList.declarations) if (ts.isIdentifier(declaration.name)) names.push(declaration.name.text)
    }
  }
  return names.sort()
}

// Public entries that still forward a whole relative module. Remove an entry when it lists its names. Do not add one.
const knownRelativeStarExports: Record<string, readonly string[]> = {
  "@vite-hub/agent/capabilities": ["./capabilities/index.ts"],
  "@vite-hub/agent/invocations": ["./d1.ts"],
  "@vite-hub/agent/process": ["./process-host.ts", "./runtime/process.ts"],
  "@vite-hub/agent/state": ["./state/sqlite.ts"],
  "@vite-hub/blob": ["./media.ts"],
  "@vite-hub/browser": ["./client.ts"],
  "@vite-hub/comments/database/postgres": ["../operations-core/database/postgres.ts"],
  "@vite-hub/comments/rpc": ["./operations-core/rpc.ts"],
  "@vite-hub/comments/server": ["./operations-core/server.ts", "./operations-core/operations.ts", "./operations-core/rpc.ts"],
  "@vite-hub/comments/testing": ["./operations-core/testing.ts"],
  "@vite-hub/ui": [
    "./components/chat.ts",
    "./components/chat-message.ts",
    "./components/prompt-input.ts",
    "./components/code-view.ts",
    "./components/patch-parsers.ts",
    "./components/file-tree.ts",
    "./components/markdown.ts",
    "./components/message-parts.ts",
    "./components/agent-session.ts",
    "./components/chat-session.ts",
    "./components/tool-list.ts",
    "./components/trace-run.ts",
    "./components/attachment.ts",
    "./components/avatar-stack.ts",
    "./components/bubble.ts",
    "./components/code-block.ts",
    "./components/comments.ts",
    "./components/connection-status.ts",
    "./components/copy-button.ts",
    "./components/device-frame.ts",
    "./components/filter-search.ts",
    "./components/marker.ts",
    "./components/message.ts",
    "./components/relative-time.ts",
    "./components/status.ts",
    "./components/sync-status.ts",
    "./components/trace.ts",
    "./composables/attachments.ts",
    "./composables/highlighted-code.ts",
    "./config.ts",
    "./headless.ts",
  ],
  "@vite-hub/ui/headless": ["./headless/message-scroller.ts", "./headless/comments.ts", "./headless/comment-visibility.ts", "./headless/choices-input.ts"],
  "@vite-hub/workflow/openworkflow": ["./runtime/openworkflow-worker.ts"],
}

// Each value an app can import from these entries. A helper that only ViteHub packages use goes in `internal/*`.
const pinnedOwnerEntries: Record<string, readonly string[]> = {
  "@vite-hub/comments": ["commentRoom", "commentsRoleAllows", "defaultPolicy", "defineCommentSubject", "defineComments", "describeCommentContext", "normalizeCommentPage"],
  "@vite-hub/forms": ["chatModalErrors", "checkForm", "createFormsInbox", "createMemoryFormsStore", "defineForm", "fieldErrors", "formFields", "handleFormRequest", "readChatModal", "readElicitation", "toChatModal", "toElicitation"],
  "@vite-hub/realtime/server": ["blobDocument", "createRealtimeHandler", "isRealtimeAvailable", "refreshRealtimeDocument", "requestRealtimeRoom", "workspaceDocument"],
  "@vite-hub/runtime": [
    "ViteHubError",
    "createExecutionContext",
    "createMemoryLeaseStore",
    "createRuntimeContext",
    "createSqlLeaseStore",
    "createTraceEventLog",
    "defineCapability",
    "defineErrors",
    "deriveTraceRuns",
    "detectHost",
    "formatRuntimeDiagnosticError",
    "getCapability",
    "getHostBinding",
    "getRuntimeContext",
    "getStandardContext",
    "getViteHubErrorShape",
    "hasCapability",
    "hostedConsoleUrl",
    "isExecutionAuthority",
    "isRuntimeDiagnostic",
    "isViteHubError",
    "noExecutionAuthority",
    "normalizeExecutionAuthority",
    "normalizeRuntimeDiagnosticError",
    "parseDuration",
    "resolveCapabilityPolicy",
    "resolvePublicUrl",
    "toResponse",
    "toResultError",
    "unknownExecutionAuthority",
  ],
  "@vite-hub/workspace": [
    "createWorkspace",
    "createWorkspaceTools",
    "custom",
    "defineWorkspace",
    "file",
    "github",
    "glob",
    "isWorkspaceConflict",
    "isWorkspaceName",
    "markdown",
    "mcpResources",
    "registerWorkspacePlugin",
    "source",
    "sourceIgnores",
    "url",
    "useWorkspace",
    "useWorkspaceFiles",
  ],
}

describe("explicit owner entries", () => {
  const entries = publicOwnerEntries()

  it("lists names instead of forwarding a whole relative module", () => {
    const found = Object.fromEntries(entries.map(entry => [entry.specifier, relativeStarExports(entry.source)]).filter(([, paths]) => paths.length))
    expect(found).toEqual(knownRelativeStarExports)
  })

  it.each(Object.entries(pinnedOwnerEntries))("pins the values of %s", (specifier, values) => {
    const entry = entries.find(candidate => candidate.specifier === specifier)
    expect(entry, `${specifier} is not a public entry`).toBeDefined()
    expect(valueExports(entry!.source)).toEqual([...values].sort())
  })
})
