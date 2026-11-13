import { defineDiagnostics } from "nostics"

const dynamicError = {
  why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
}

/** A code whose call site passes the message as `why`. Pass the fix as a string literal: the docs catalog reads only literals. */
const withFix = (fix: string) => ({ ...dynamicError, fix })

// Each code identifies one ViteHub failure site. Keep published codes stable.
// Retired codes. Do not reuse them: ENV_R0007 and ENV_R0024.
export const envErrorDiagnostics = /*#__PURE__*/ defineDiagnostics({
  docsBase: "https://vitehub.dev/docs/env/diagnostics",
  codes: {
    ENV_R0001: withFix("Change the value so that it matches the type of the variable. The value comes from `.env`, the host environment, a source, a provider, or the `default` of the declaration. The message names each issue."),
    ENV_R0002: withFix("Pass one or more variable names, for example `env.source('DATABASE_URL')`."),
    ENV_R0003: withFix("Use a key of `vitehub({ env: { providers } })` or `hubEnv({ providers })` as the provider name, for example `env.provider('vault', 'db/password')`."),
    ENV_R0004: withFix("Pass the key that the provider reads as the second argument, for example `env.provider('vault', 'db/password')`."),
    ENV_R0005: withFix("Pass one plain options object, for example `env({ secret: true })`."),
    ENV_R0006: withFix("Set `optional: true` or `required`, not both."),
    ENV_R0008: withFix("Change the Env declaration at the path in the error details, as the message says."),
    ENV_R0009: withFix("Load Server Env with `await loadServerEnv()`, or run the code in `runWithServerEnv()`. A provider value cannot be read without `await`."),
    ENV_R0010: withFix("Give the variable a value at its source: set it in `.env` or in the host environment, or return it from the provider or the custom source. Or set `optional: true` on the declaration, or a `default` if the variable is not secret. Run `vitehub env check` to list the missing variables."),
    ENV_R0011: withFix("Change the value at its source, or the `default` of the declaration, so that it matches the type of the variable. The message names each issue. If the message names a provider, make its `read()` return a plain object with a value for each key, not a getter."),
    ENV_R0012: withFix("Make package.json contain one JSON object."),
    ENV_R0013: withFix("Pass an object with a `read({ env, keys, signal })` method to `defineEnvProvider()`."),
    ENV_R0014: withFix("Use a schema that validates without a Promise for this variable."),
    ENV_R0015: withFix("Change the value so that it matches the schema of the variable. The value comes from `.env`, the host environment, a source, a provider, or the `default` of the declaration. The message names each issue."),
    ENV_R0016: withFix("Change the value so that it matches the schema of the variable. The value comes from `.env`, the host environment, a source, a provider, or the `default` of the declaration. The message names each issue."),
    ENV_R0017: withFix("Change the value so that it matches the schema of the variable. The value comes from `.env`, the host environment, a source, a provider, or the `default` of the declaration. The message names each issue."),
    ENV_R0018: withFix("Change the value so that it matches the schema of the variable. The value comes from `.env`, the host environment, a source, a provider, or the `default` of the declaration. The message names each issue."),
    ENV_R0019: withFix("Make the provider module default-export `defineEnvProvider({ read })`, and list it in `vitehub({ env: { providers } })` or `hubEnv({ providers })`. If you call `loadServerEnv()` directly, pass the provider in `options.providers`."),
    ENV_R0020: withFix("The caller aborted the load. Load Server Env again with a signal that is not aborted."),
    ENV_R0021: withFix("This is a ViteHub bug. Report it at https://github.com/vite-hub/vitehub/issues with the message and your Vite config."),
    ENV_R0022: withFix("Pass unique, non-empty strings, for example `env.enum(['development', 'production'])`."),
    ENV_R0023: withFix("Change the `default` so that it matches the schema, for example a number for `env.number()`."),
    ENV_R0025: withFix("Put a stage name after `--stage`, for example `vitehub env check --stage production`."),
    ENV_R0026: withFix("Remove the option. `vitehub env <command> --help` lists the options."),
    ENV_R0027: withFix("Add `vitehub()` or `hubEnv()` to the Vite plugins of the selected stage."),
    ENV_R0028: withFix("This is a ViteHub bug. Report it at https://github.com/vite-hub/vitehub/issues with the message and your Vite config."),
    ENV_R0029: withFix("Pass a non-empty module specifier and an export name that is a JavaScript identifier, for example `env.schemaFrom('./server/env.schema.ts', 'apiUrl')`. Use `env.schemaFrom()` only in `env.server`. Elsewhere, pass the schema object itself."),
    ENV_R0030: withFix("Configure Vite's SSR environment with a RunnableDevEnvironment so Env can import its server module."),
    ENV_B0001: withFix("Add `vitehub()` or `hubEnv()` to the Vite plugins once. If it is there, report a ViteHub bug at https://github.com/vite-hub/vitehub/issues with your Vite config."),
    ENV_B0002: withFix("Rename the key in `vitehub({ env: { providers } })` or `hubEnv({ providers })`, for example `vault` or `aws_secrets`. Use at most 64 characters."),
    ENV_B0003: withFix("Set the provider to a module specifier, for example `'./server/env-provider.ts'` or a package name."),
    ENV_B0004: withFix("Use a relative path, a normal absolute path, or a package name for the provider module."),
    ENV_B0005: withFix("Add the provider to `vitehub({ env: { providers } })` or `hubEnv({ providers })`, or use a configured provider name in `env.provider()`."),
    ENV_B0006: withFix("Change the env-spec schema file at the file and line that the message names, so that it follows the env-spec format."),
    ENV_B0007: withFix("Stop other Vite processes of this project. If none runs, delete `.vitehub/env/secret.lock` and run the command again."),
    ENV_NOT_GENERATED: {
      why: ({ accessor }: { accessor: string }) => `\`${accessor}()\` ran outside a Vite build, so ViteHub did not generate the Env registry that it reads.`,
      fix: "Run the code through `vite dev`, `vite build`, or a framework that uses them, with `vitehub()` and Env on. A test that calls it needs the Vite plugin too.",
    },
  },
})
