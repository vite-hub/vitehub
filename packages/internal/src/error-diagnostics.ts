import { defineDiagnostics } from "nostics"

const dynamicError = {
  why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
}

// Each code identifies one ViteHub failure site. Keep published codes stable.
// Retired codes. Do not reuse them: INTERNAL_B0002 to INTERNAL_B0014, INTERNAL_B0023, INTERNAL_B0024, INTERNAL_B0030, INTERNAL_B0034, INTERNAL_B0036 to INTERNAL_B0038, INTERNAL_B0041, INTERNAL_B0042, INTERNAL_B0044, INTERNAL_B0045, and INTERNAL_R0003.
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
      fix: "Send input that matches the schema of the operation. `vitehub <namespace> <command> --help` shows the fields.",
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
    INTERNAL_B0033: { ...dynamicError, fix: "Add a `main.ts` file at the project root that imports `./schedule/deno-cron.mjs` and then `./server/index.mjs`, or remove the Schedules from `server/schedules/`." },
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
    INTERNAL_R0002: { ...dynamicError, fix: "Stop using the feature that the message names, or set `host` in `vitehub()` to a host that provides it. For Blob, you can also set `blob: { driver: \"s3\" }` with a remote store." },
    INTERNAL_R0004: { ...dynamicError, fix: "Set a larger `maxResponseBytes` on the HTTP request, such as the `fetch()` Source options, or ask the server for a smaller response." },
    INTERNAL_R0005: { ...dynamicError, fix: "Set `method` of the HTTP request to `GET`, `HEAD`, or `POST`." },
    INTERNAL_R0006: { ...dynamicError, fix: "Set `timeout` of the HTTP request to a number of milliseconds from 1 to 2147483647, or remove it to use the default." },
    INTERNAL_R0007: { ...dynamicError, fix: "Set `maxResponseBytes` of the HTTP request to a positive integer no greater than the limit that the message names, or remove it to use the default." },
    INTERNAL_R0008: { ...dynamicError, fix: "Make the value that the message names match its schema: the input, query, or body that you send, or the response schema that you declare for the request." },
    INTERNAL_R0009: { ...dynamicError, fix: "Use a Standard Schema whose `validate()` returns `{ value }` or `{ issues }` for the value that the message names." },
    INTERNAL_R0010: { ...dynamicError, fix: "Run the command again. If the error stays, check the Cloudflare API status, because Cloudflare sent a response that ViteHub cannot read." },
    INTERNAL_R0011: { ...dynamicError, fix: "Pass an h3 app, an object with a `fetch(request)` method, or a fetch function as `app`." },
  },
})
