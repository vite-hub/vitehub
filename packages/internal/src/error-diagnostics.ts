import { defineDiagnostics } from "nostics"

const dynamicError = {
  why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
}

// Each code identifies one ViteHub failure site. Keep published codes stable.
// Retired codes. Do not reuse them: INTERNAL_B0002 to INTERNAL_B0014, INTERNAL_B0023, INTERNAL_B0024, INTERNAL_B0030, INTERNAL_B0033, INTERNAL_B0034, INTERNAL_B0036 to INTERNAL_B0038, INTERNAL_B0041, INTERNAL_B0042, INTERNAL_B0044, INTERNAL_B0045, and INTERNAL_R0003.
export const internalErrorDiagnostics = /*#__PURE__*/ defineDiagnostics({
  docsBase: "https://vitehub.dev/docs/development/diagnostics",
  codes: {
    INTERNAL_R0012: { ...dynamicError, fix: "Check the URL, the headers, and the credentials of the HTTP request. `error.status` holds the status that the server sent." },
    INTERNAL_R0013: { ...dynamicError, fix: "Check that the provider token can manage the resource in the path that the message names. `error.kind` and `error.codes` hold the provider failure." },
    INTERNAL_R0014: {
      why: ({ path }: { path: string }) => `Cannot read Provision State from "${path}".`,
      fix: "Check file access and restore valid JSON while preserving existing resource IDs.",
    },
    INTERNAL_R0020: {
      fix: "Give the operation a name like `content.publish`, a description, a section, a kind, an input schema, and a run function.",
      why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
    },
    INTERNAL_R0021: {
      fix: "Run `vitehub inspect definitions --kind operation` to list the operations of this app.",
      why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
    },
    INTERNAL_R0022: {
      fix: "Send input that matches the schema of the operation. `vitehub <namespace> <command> --help` shows the fields, and the list_operations tool of the ViteHub MCP gives the input schema of each operation.",
      why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
    },
    INTERNAL_R0024: {
      fix: "Start the dev server with `vite dev`, or pass `--url <origin>` of a deployed app and set VITEHUB_CONSOLE_PRIVATE_KEY_<NAME> to a private key whose public key the app has in VITEHUB_CONSOLE_KEY_<NAME>.",
      why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
    },
    INTERNAL_R0023: {
      fix: "Ask for access to the section of this operation.",
      why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
    },
    INTERNAL_B0001: { ...dynamicError, fix: "Give the resource that the message names another name or binding in the `vitehub()` options of its feature, so that two different Cloudflare resources do not share one name." },
    INTERNAL_B0015: { ...dynamicError, fix: "Install one version of the package that the message names, for example with `pnpm dedupe` or an `overrides` entry in `package.json`." },
    INTERNAL_B0016: { ...dynamicError, fix: "Correct the field that the message names in the `package.json` of a runtime dependency of the app, such as a workspace package, or run `pnpm install` again to restore an installed package." },
    INTERNAL_B0017: { ...dynamicError, fix: "Correct the field that the message names in the `package.json` of a runtime dependency of the app, such as a workspace package, or run `pnpm install` again to restore an installed package." },
    INTERNAL_B0018: { ...dynamicError, fix: "Correct the field that the message names in the `package.json` of a runtime dependency of the app, such as a workspace package, or run `pnpm install` again to restore an installed package." },
    INTERNAL_B0019: { ...dynamicError, fix: "Correct the field that the message names in the `package.json` of a runtime dependency of the app, such as a workspace package, or run `pnpm install` again to restore an installed package." },
    INTERNAL_B0020: { ...dynamicError, fix: "Correct the field that the message names in the `package.json` of a runtime dependency of the app, such as a workspace package, or run `pnpm install` again to restore an installed package." },
    INTERNAL_B0021: { ...dynamicError, fix: "Install the package that the message names in the app, for example with `pnpm add <name>`, then build again." },
    INTERNAL_B0022: { ...dynamicError, fix: "Install one version of the package that the message names, for example with `pnpm dedupe` or an `overrides` entry in `package.json`." },
    INTERNAL_B0025: { ...dynamicError, fix: "Replace the `new URL(\"./...\", import.meta.url)` in the project-root `main.ts`, or in a Schedule file of `server/schedules/` and the files it imports, with a static `import` of that file." },
    INTERNAL_B0026: { ...dynamicError, fix: "Replace the computed `import()` in the project-root `main.ts`, or in a Schedule file of `server/schedules/` and the files it imports, with a static `import` or with `import(\"<literal path>\")`." },
    INTERNAL_B0027: { ...dynamicError, fix: "Replace the computed `require()` in the project-root `main.ts`, or in a Schedule file of `server/schedules/` and the files it imports, with a static `import`." },
    INTERNAL_B0028: { ...dynamicError, fix: "Wait for the other build of this app to finish, or stop the process that the message names, then build again." },
    INTERNAL_B0029: { ...dynamicError, fix: "Stop the other builds that write the same Deno output folder, delete the `.vitehub-lock` folder next to that output folder, such as `.output.vitehub-lock`, then build again." },
    INTERNAL_B0031: { ...dynamicError, fix: "Import `./schedule/deno-cron.mjs` at the top level of the project-root `main.ts`, for example with `await import(new URL(\"./schedule/deno-cron.mjs\", import.meta.url).href)` outside any condition." },
    INTERNAL_B0032: { ...dynamicError, fix: "Import `./server/index.mjs` at the top level of the project-root `main.ts`, for example with `await import(new URL(\"./server/index.mjs\", import.meta.url).href)` outside any condition." },
    INTERNAL_B0035: { ...dynamicError, fix: "Delete the provider output folder that holds the file that the message names, such as `dist/<app>` for Cloudflare, and build again." },
    INTERNAL_B0039: { ...dynamicError, fix: "Fix the build error that ViteHub showed before this one. ViteHub stops writing the provider output when another part of the build fails." },
    INTERNAL_B0040: { ...dynamicError, fix: "Remove the custom Nitro `output.serverDir`, so that the Nitro preset of the host writes the server entry that the message names." },
    INTERNAL_B0043: { ...dynamicError, fix: "Delete the build output folder, such as `.output` or `.vercel/output`, and build again." },
    INTERNAL_B0046: { ...dynamicError, fix: "Install the package that the message names in the app, for example with `pnpm add <name>`, then build again." },
    INTERNAL_B0047: { ...dynamicError, fix: "Correct the `package.json` file that the message names so that it holds one JSON object, or run `pnpm install` again to restore an installed package." },
    INTERNAL_B0048: {
      fix: "Rename one of the two operations. A name is `<section>.<verb>` and is unique in the app.",
      why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
    },
    INTERNAL_B0049: {
      fix: "Set `cli: { namespace, command }` on one of the two operations.",
      why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
    },
    INTERNAL_B0050: {
      fix: "Rename one of the two operations, or set `mcp: false` on it. MCP tool names replace every character outside letters, digits, `_`, and `-` with `_`.",
      why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
    },
    INTERNAL_B0051: {
      why: ({ field, generated, name, path, project, scope }: { field: string, generated: string, name: string, path: string, project: string, scope: string }) => `The Cloudflare ${path} entry "${name}"${scope} is written by ViteHub and by the project's Wrangler config with a different ${field}: ${generated} and ${project}.`,
      fix: "Remove the entry from the project's Wrangler config, since ViteHub writes it, or give one of them another name.",
    },
    INTERNAL_B0052: {
      why: ({ column, section }: { column: string, section: string }) => `The column "${column}" of the Console section "${section}" needs both \`format: "switch"\` and a \`switch\` operation name such as "skills.set".`,
      fix: "Give a switch column `format: \"switch\"` and `switch: { operation, input }` with a registered operation name, or remove both.",
    },
    INTERNAL_R0025: {
      fix: "Start `vite dev` in the project that you run the command from, or pass `--url` of that server.",
      why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
    },
    INTERNAL_R0026: {
      why: "The server parsed a destructive operation that the CLI did not confirm.",
      fix: "Review the operation, then run it again with --yes to confirm the change.",
    },
    INTERNAL_C0001: { ...dynamicError, fix: "Rename or remove one of the two files that the message lists. ViteHub takes the Definition name from the file path." },
    INTERNAL_C0002: { ...dynamicError, fix: "Rename or remove one of the two files that the message lists. ViteHub takes the Definition name from the file path." },
    INTERNAL_R0001: { ...dynamicError, fix: "Set `host` in `vitehub()`, or in the `vitehub` options of `nuxt.config.ts`, to `cloudflare`, `deno`, `netlify`, `node`, or `vercel`. Or remove `host` so that ViteHub finds the host from the environment." },
    INTERNAL_R0002: { ...dynamicError, fix: ({ fix }: { message?: unknown, fix?: string }) => fix ?? "Set `host` in `vitehub()` to a host that provides this capability, or remove the capability from `vitehub()`." },
    INTERNAL_R0004: { ...dynamicError, fix: "Set a larger `maxResponseBytes` on the HTTP request, such as the `url()` Source options, or ask the server for a smaller response." },
    INTERNAL_R0005: { ...dynamicError, fix: "Set `method` of the HTTP request to `GET`, `HEAD`, or `POST`." },
    INTERNAL_R0006: { ...dynamicError, fix: "Set `timeout` of the HTTP request to a number of milliseconds from 1 to 2147483647, or remove it to use the default." },
    INTERNAL_R0007: { ...dynamicError, fix: "Set `maxResponseBytes` of the HTTP request to a positive integer no greater than the limit that the message names, or remove it to use the default." },
    INTERNAL_R0008: { ...dynamicError, fix: "Make the value that the message names match its schema: the input, query, or body that you send, or the response schema that you declare for the request." },
    INTERNAL_R0009: { ...dynamicError, fix: "Use a Standard Schema whose `validate()` returns `{ value }` or `{ issues }` for the value that the message names." },
    INTERNAL_R0010: { ...dynamicError, fix: "Run the command again. If the error stays, check the Cloudflare API status, because Cloudflare sent a response that ViteHub cannot read." },
    INTERNAL_R0011: { ...dynamicError, fix: "Pass an h3 app, an object with a `fetch(request)` method, or a fetch function as `app`." },
    // Named errors. Keep these codes in alphabetical order.
    INTERNAL_CONSOLE_KEY_NAME_INVALID: {
      why: ({ name }: { name: string }) => `[vitehub] The Console key name ${JSON.stringify(name)} must be 1 to 64 of A-Z, 0-9, and _.`,
      fix: "Name the Console key with 1 to 64 characters from A-Z, 0-9, and _, such as `CI`. The app reads its public key from `VITEHUB_CONSOLE_KEY_<NAME>`.",
    },
    INTERNAL_CONSOLE_PRIVATE_KEY_INVALID: {
      why: "[vitehub] A Console private key is the 32-byte Ed25519 seed as base64url (43 characters). `vitehub secret console-key` makes one.",
      fix: "Run `vitehub secret console-key` and use the 43-character private key that it prints, without spaces or quotes.",
    },
    INTERNAL_CONSOLE_PRIVATE_KEY_VARIABLES_MULTIPLE: {
      why: ({ prefix, variables }: { prefix: string, variables: string }) => `[vitehub] Set one ${prefix}<NAME> variable. This environment has ${variables}.`,
      fix: "Keep one `VITEHUB_CONSOLE_PRIVATE_KEY_<NAME>` variable in the environment of the command, and unset the others that the message names.",
    },
    INTERNAL_CONSOLE_PRIVATE_KEY_VARIABLE_INVALID: {
      why: ({ variable }: { variable: string }) => `[vitehub] ${variable} must be the 43-character private key that \`vitehub secret console-key\` prints, and its name 1 to 64 of A-Z, 0-9, and _.`,
      fix: "Set the variable that the message names to the private key that `vitehub secret console-key` prints, and name it `VITEHUB_CONSOLE_PRIVATE_KEY_<NAME>` with A-Z, 0-9, and _ in `<NAME>`.",
    },
    INTERNAL_DEV_SERVER_NOT_FOUND: {
      why: ({ command }: { command: string }) => `[vitehub] No dev server of this project is running, and --url is not set, so \`vitehub ${command}\` has no app to call.`,
      fix: "Start the dev server of this project, such as with `pnpm dev`, or pass --url with the app URL, such as --url http://localhost:3000.",
    },
    INTERNAL_FORGE_NOT_INSTALLED: {
      why: ({ feature }: { feature: string }) => `${feature} needs @vite-hub/forge, and the app did not install it.`,
      fix: "Install Forge in your app with `pnpm add @vite-hub/forge`, then build again.",
    },
    INTERNAL_MCP_ARGUMENTS_INVALID: {
      why: ({ detail }: { detail: string }) => detail,
      fix: "Pass the prompt or resource the arguments that `prompts/list` or `resources/templates/list` describes for it.",
    },
    INTERNAL_MCP_METHOD_FAILED: {
      why: ({ name }: { name: string }) => `${name} failed on the server.`,
      fix: "Read the server log for the error of the MCP prompt or resource that the message names, and fix its handler.",
    },
    INTERNAL_MCP_RESOURCE_NOT_FOUND: {
      why: ({ uri }: { uri: string }) => `Resource not found: ${uri}. Call resources/list or resources/templates/list for the resources of this server.`,
      fix: "Call `resources/list` or `resources/templates/list`, and read a URI that one of them returns.",
    },
    INTERNAL_PRESET_OPTION_UNKNOWN: {
      why: ({ key, label }: { key: string, label: string }) => `[vitehub] Unknown ${label} option "${key}".`,
      fix: "Remove the option that the message names from the preset options, or correct its spelling to an option that the preset declares.",
    },
    INTERNAL_PRESET_TUPLE_INVALID: {
      why: ({ owner }: { owner: string }) => `[vitehub] ${owner} extends tuple requires [preset, options] with an options object.`,
      fix: "Set `extends` to a preset, or to a two-item tuple `[preset, { ...options }]` whose second item is a plain object.",
    },
    INTERNAL_RUNTIME_PACKAGE_VERSION_CONFLICT: {
      why: ({ first, name, second }: { first: string, name: string, second: string }) => `[vitehub] One server function needs ${name} from two installations: ${first} and ${second}.`,
      fix: "Install one version of the package that the message names, for example with `pnpm dedupe` or an `overrides` entry in `package.json`, then build again.",
    },
    INTERNAL_SECRET_PURPOSE_MISSING: {
      why: "[vitehub] A derived secret requires a purpose.",
      fix: "Pass a non-empty purpose to `deriveSecret()`, such as `deriveSecret(\"my-module:session\")`.",
    },
    INTERNAL_SECRET_TOO_SHORT: {
      why: ({ minimum }: { minimum: number }) => `[vitehub] VITEHUB_SECRET must be at least ${minimum} characters. Generate one with \`openssl rand -base64 32\`.`,
      fix: "Set `VITEHUB_SECRET` to the output of `openssl rand -base64 32`, which has 44 characters.",
    },
    INTERNAL_SITE_TOKEN_TOO_LONG: {
      why: ({ length, maximum }: { length: number, maximum: number }) => `The Site access token is ${length} characters, and an app accepts ${maximum}.`,
      fix: "Open the app with a shorter path, or give the person and the project shorter names, so that the Site access token fits.",
    },
    INTERNAL_SQLITE_ARGUMENT_INVALID: {
      why: ({ value }: { value: "non-finite" | "undefined" }) => value === "undefined" ? "undefined cannot be passed as argument to the database" : "Only finite numbers (not Infinity or NaN) can be passed as arguments",
      fix: "Pass query arguments as finite numbers, strings, booleans, bigints, dates, byte arrays, or null. Replace undefined with null, and check numbers with `Number.isFinite()` before the query.",
    },
    INTERNAL_SQLITE_INTEGER_UNSAFE: {
      why: "Received integer which cannot be safely represented as a JavaScript number",
      fix: "Create the client with `intMode: \"bigint\"` or `intMode: \"string\"`, or read the column with `CAST(column AS TEXT)` in the query.",
    },
    INTERNAL_VALIBOT_JSON_SCHEMA_TARGET_UNSUPPORTED: {
      why: ({ target }: { target: string }) => `[vitehub] Valibot cannot convert a schema to the ${target} JSON Schema target.`,
      fix: "Ask for the `draft-07`, `draft-2020-12`, or `openapi-3.0` JSON Schema target, or pass one of them as `withValibotJsonSchema(schema, { target })`.",
    },
  },
})
