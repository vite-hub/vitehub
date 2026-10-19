import { defineErrors } from "@vite-hub/runtime"

function quoteList(values: readonly string[]): string {
  return values.map(value => JSON.stringify(value)).join(", ")
}

function fileList(files: readonly string[]): string {
  return files.map(file => `\n  - ${file}`).join("")
}

interface LayerOptionsProblem {
  database: string
  files: readonly string[]
  /** Options that a layer sets and the application definition does not. Only for `reason: "missing"`. */
  options?: string
  reason: "layers" | "missing" | "unreadable"
}

interface ContributionTargetProblem {
  /** Names of the Database Definitions. */
  choices?: readonly string[]
  database?: string
  dialect?: string
  reason: "ambiguous" | "dialect" | "missing" | "none"
  source: string
  targetDialect?: string
}

function describeLayerOptionsProblem({ database, options, reason }: LayerOptionsProblem): string {
  if (reason === "layers") return `More than one Nuxt layer sets options for the database "${database}".`
  const replaces = `The application definition of the database "${database}" sets options, so it replaces the options of its Nuxt layers.`
  return reason === "missing"
    ? `${replaces} It does not set ${options}, which a layer sets.`
    : `${replaces} ViteHub cannot read the options of these definitions.`
}

function describeContributionTarget({ choices = [], database, dialect, reason, source, targetDialect }: ContributionTargetProblem): string {
  switch (reason) {
    case "none":
      return `${source} need a Database, but the app has no Database Definition.`
    case "ambiguous":
      return `${source} target the default Database, but the app has several Database Definitions and none is named "default": ${quoteList(choices)}.`
    case "missing":
      return `${source} target the Database "${database}", which has no Database Definition. Database Definitions: ${choices.length ? quoteList(choices) : "none"}.`
    case "dialect":
      return `${source} use the "${dialect}" dialect, but the Database "${database}" uses "${targetDialect}".`
  }
}

// Keep published codes stable. Each code has a heading on the docs page.
export const databaseErrorDiagnostics = /*#__PURE__*/ defineErrors({
  docs: "https://vitehub.dev/docs/database/limits-and-errors",
  codes: {
    DATABASE_C0007: {
      why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
      fix: "Provide a string name for the Database Definition.",
    },
    // Runtime errors. A Drizzle query rejects with them, because Drizzle owns the query API.
    DATABASE_D1_INVALID_RESPONSE: {
      why: "Cloudflare D1 returned a different number of results than the number of queries.",
      fix: "Retry the query. If it fails again, open a ViteHub issue with the query and the D1 HTTP response.",
    },
    DATABASE_D1_REQUEST_FAILED: {
      why: ({ detail, label, status }: { detail?: string, label: string, status: number }) => `Cloudflare D1 ${label} failed with HTTP ${status}${detail ? `: ${detail}` : "."}`,
      fix: "Read the D1 message in `why`. Check the SQL, the D1 API token permissions, and the D1 database id.",
    },

    // Config errors. ViteHub throws them when code first uses the database, because the code or the deployment must change.
    DATABASE_DISABLED: {
      why: "Database is not configured in this runtime.",
      fix: "Add `hubDb()` to the Vite config and do not set `database: false`.",
    },
    DATABASE_INVALID_D1_HTTP_URL: {
      why: ({ database }: { database: string }) => `\`cloudflare.http.url\` of the database "${database}" is not an HTTP or HTTPS URL.`,
      fix: "Set `cloudflare.http.url` to the D1 HTTP endpoint, for example `https://api.cloudflare.com/client/v4/accounts/<account>/d1/database/<id>/raw`.",
    },
    DATABASE_MISSING_CONNECTION: {
      why: ({ database, needs }: { database: string, needs: string }) => `The database "${database}" has no connection. It needs ${needs}.`,
      fix: "On Cloudflare, add the binding to the Worker configuration. On other hosts, set `connection.url` in the Database Definition or its environment variable.",
    },
    DATABASE_MISSING_D1_HTTP_CONFIG: {
      why: ({ database, missing }: { database: string, missing: string }) => `The database "${database}" uses D1 HTTP and needs ${missing} at runtime.`,
      fix: "Set the missing values in the Database Definition or in the runtime environment, then restart the server.",
    },
    DATABASE_NOT_FOUND: {
      why: ({ database }: { database: string }) => `The database "${database}" is not configured.`,
      fix: "Add a Database Definition with this name, for example `server/databases/<name>.ts`, or use the name of a discovered database. Run `vitehub inspect definitions --kind database` to see them.",
    },

    // Definition errors. `defineDatabase()` throws them.
    DATABASE_INVALID_CASING: {
      why: "`defineDatabase().drizzle.casing` must be `snake_case` or `camelCase`.",
      fix: "Set `drizzle: { casing: 'snake_case' }` or `drizzle: { casing: 'camelCase' }`, or remove `casing`.",
    },
    DATABASE_INVALID_DIALECT: {
      why: ({ file }: { file?: string }) => file
        ? `The Database Definition "${file}" must set \`dialect\` to the string literal "sqlite" or "postgresql".`
        : "`defineDatabase().dialect` must be `sqlite` or `postgresql`.",
      fix: "Set `dialect: 'sqlite'` or `dialect: 'postgresql'` as a string literal, or remove it to use SQLite.",
    },
    DATABASE_INVALID_NAME: {
      why: "`defineDatabase().name` must be a normalized path of letters, numbers, dots, underscores, or dashes.",
      fix: "Use a name such as `analytics` or `reports/daily`.",
    },
    DATABASE_INVALID_OPTIONS: {
      why: ({ path }: { path: string }) => `\`${path}\` must be a plain object.`,
      fix: "Pass an object literal, for example `defineDatabase({ schema: { notes } })`.",
    },
    DATABASE_UNKNOWN_OPTION: {
      why: ({ dialect, option }: { dialect?: "postgresql", option: string }) => dialect
        ? `\`defineDatabase()\` with \`dialect: "postgresql"\` does not support \`${option}\`.`
        : `\`defineDatabase()\` does not support the "${option}" option.`,
      fix: "Remove the option. The Database configure page lists the options of each dialect.",
    },

    // Build errors. ViteHub throws them when it discovers Database Definitions or builds the app.
    DATABASE_BINDING_CONFLICT: {
      why: ({ binding, first, kind, second }: { binding: string, first: string, kind: "D1" | "Hyperdrive", second: string }) => `${first} and ${second} use the same Cloudflare ${kind} binding "${binding}".`,
      fix: "Set `cloudflare.binding` to a different name for each Database Definition.",
    },
    DATABASE_DUPLICATE_DEFINITION: {
      why: ({ database, files }: { database: string, files: readonly string[] }) => `${database === "default" ? "Only one default Database Definition is allowed." : `Only one definition is allowed for the database "${database}".`}${fileList(files)}`,
      fix: "Remove one of the definitions, or give it another name.",
    },
    DATABASE_DUPLICATE_TABLE: {
      why: ({ database, first, kind, name, second }: { database: string, first: string, kind: "schema key" | "table", name: string, second: string }) => `The database "${database}" has two ${kind}s named "${name}":${fileList([first, second])}`,
      fix: "Rename one of them, or remove the contribution. If the Definition already lists the contributed tables, remove them from its schema.",
    },
    DATABASE_INVALID_CONTRIBUTION: {
      why: ({ problem }: { problem: string }) => problem,
      fix: "Fix the `vitehub.databases` entry of the plugin. Each entry needs a unique `name` and `definition: { module, export? }` that points to an object of Drizzle tables.",
    },
    DATABASE_INVALID_CONTRIBUTION_TARGET: {
      why: (problem: ContributionTargetProblem) => describeContributionTarget(problem),
      fix: "Add `server/databases/config.ts` with `defineDatabase({ schema: {} })`, or set the `database` option of the contribution to a Database Definition with the same dialect.",
    },
    DATABASE_INVALID_SCHEMA_EXPORT: {
      why: ({ handler }: { handler: string }) => `The Database Definition "${handler}" must default export \`defineDatabase({ schema })\` with a schema object.`,
      fix: "Default export the result of `defineDatabase({ schema: { ... } })` from the file.",
    },
    DATABASE_LAYER_OPTIONS_CONFLICT: {
      why: (problem: LayerOptionsProblem) => `${describeLayerOptionsProblem(problem)}${fileList(problem.files)}`,
      fix: "Keep every option in one file: the application definition or one layer. Pass an object literal to `defineDatabase()`, so that ViteHub can read the options.",
    },
    DATABASE_LAYER_TABLE_CONFLICT: {
      why: ({ database, files, table }: { database: string, files: readonly string[], table: string }) => `More than one Nuxt layer declares the table "${table}" in the database "${database}":${fileList(files)}`,
      fix: "Rename one table, or declare the table in the application definition to replace both.",
    },
    DATABASE_MISSING_D1_RESOURCE: {
      why: ({ databases, missing }: { databases: readonly string[], missing: string }) => `Cloudflare D1 output needs ${missing} for ${quoteList(databases)}.`,
      fix: "Set `cloudflare.databaseId` and `cloudflare.databaseName` at build time, or run `vitehub provision run --provider cloudflare`. For values that resolve at runtime, use D1 HTTP or a remote libSQL connection.",
    },
    DATABASE_MIXED_DEFINITIONS: {
      why: ({ files }: { files: readonly string[] }) => `Database Definitions must use one default database or only named databases, not both.${fileList(files)}`,
      fix: "Rename the default definition to a named one, or merge the named definitions into the default one.",
    },
    DATABASE_NAME_MISMATCH: {
      why: ({ file, name }: { file: string, name: string }) => `The Database Definition "${file}" must set \`name: ${JSON.stringify(name)}\` to match its file name.`,
      fix: "Set `name` to the name from the file path, or remove `name`.",
    },
    DATABASE_OPAQUE_CLOUDFLARE_CONFIG: {
      why: ({ databases }: { databases: readonly string[] }) => `Cloudflare D1 output needs a literal \`cloudflare\` object for ${quoteList(databases)}.`,
      fix: "Write `cloudflare: { ... }` as an object literal in `defineDatabase()`, or use D1 HTTP or a remote libSQL connection.",
    },
    DATABASE_PROVISION_FAILED: {
      why: ({ problem }: { problem: "database" | "list" }) => problem === "list"
        ? "Cloudflare returned an invalid D1 database list during provisioning."
        : "Cloudflare returned an invalid D1 database during provisioning.",
      fix: "Run `vitehub provision run --provider cloudflare --dry-run` again, and check the Cloudflare token permissions.",
    },
    DATABASE_RESERVED_SCHEMA_KEY: {
      why: ({ key, owner }: { key: string, owner: string }) => `${owner} uses the reserved schema key "${key}".`,
      fix: "Rename the table key in the schema object.",
    },
    DATABASE_SCHEMA_LOAD_FAILED: {
      why: ({ problem, source }: { problem: string, source: string }) => `${source} could not load: ${problem}`,
      fix: "Read `error.cause` for the import error, and fix the module. `vitehub db generate` needs every schema module to load.",
    },
  },
})
