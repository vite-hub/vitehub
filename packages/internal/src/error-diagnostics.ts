import { defineDiagnostics } from "nostics"

const dynamicError = {
  why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
}

// Each code identifies one ViteHub failure site. Keep published codes stable.
// Retired codes. Do not reuse them: INTERNAL_B0002 to INTERNAL_B0008, INTERNAL_B0023, INTERNAL_B0024, INTERNAL_B0041, INTERNAL_B0042, INTERNAL_B0044, and INTERNAL_B0045.
export const internalErrorDiagnostics = /*#__PURE__*/ defineDiagnostics({
  docsBase: "https://vitehub.dev/docs/development/diagnostics",
  codes: {
    INTERNAL_R0012: dynamicError,
    INTERNAL_R0013: dynamicError,
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
    INTERNAL_B0001: dynamicError,
    INTERNAL_B0009: dynamicError,
    INTERNAL_B0010: dynamicError,
    INTERNAL_B0011: dynamicError,
    INTERNAL_B0012: dynamicError,
    INTERNAL_B0013: dynamicError,
    INTERNAL_B0014: dynamicError,
    INTERNAL_B0015: { ...dynamicError, fix: "Install one version of the package that the message names, for example with `pnpm dedupe` or an `overrides` entry in `package.json`." },
    INTERNAL_B0016: dynamicError,
    INTERNAL_B0017: dynamicError,
    INTERNAL_B0018: dynamicError,
    INTERNAL_B0019: dynamicError,
    INTERNAL_B0020: dynamicError,
    INTERNAL_B0021: dynamicError,
    INTERNAL_B0022: dynamicError,
    INTERNAL_B0025: { ...dynamicError, fix: "Replace the `new URL(\"./...\", import.meta.url)` in the project-root `main.ts`, or in a Schedule file of `server/schedules/` and the files it imports, with a static `import` of that file." },
    INTERNAL_B0026: { ...dynamicError, fix: "Replace the computed `import()` in the project-root `main.ts`, or in a Schedule file of `server/schedules/` and the files it imports, with a static `import` or with `import(\"<literal path>\")`." },
    INTERNAL_B0027: { ...dynamicError, fix: "Replace the computed `require()` in the project-root `main.ts`, or in a Schedule file of `server/schedules/` and the files it imports, with a static `import`." },
    INTERNAL_B0028: dynamicError,
    INTERNAL_B0029: dynamicError,
    INTERNAL_B0030: dynamicError,
    INTERNAL_B0031: dynamicError,
    INTERNAL_B0032: dynamicError,
    INTERNAL_B0033: dynamicError,
    INTERNAL_B0034: dynamicError,
    INTERNAL_B0035: dynamicError,
    INTERNAL_B0036: dynamicError,
    INTERNAL_B0037: dynamicError,
    INTERNAL_B0038: dynamicError,
    INTERNAL_B0039: dynamicError,
    INTERNAL_B0040: { ...dynamicError, fix: "Remove the custom Nitro `output.serverDir`, so that the Nitro preset of the host writes the server entry that the message names." },
    INTERNAL_B0043: { ...dynamicError, fix: "Delete the build output folder, such as `.output` or `.vercel/output`, and build again." },
    INTERNAL_B0046: dynamicError,
    INTERNAL_B0047: dynamicError,
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
    INTERNAL_R0003: dynamicError,
    INTERNAL_R0004: dynamicError,
    INTERNAL_R0005: dynamicError,
    INTERNAL_R0006: dynamicError,
    INTERNAL_R0007: dynamicError,
    INTERNAL_R0008: dynamicError,
    INTERNAL_R0009: dynamicError,
    INTERNAL_R0010: dynamicError,
    INTERNAL_R0011: dynamicError,
  },
})
