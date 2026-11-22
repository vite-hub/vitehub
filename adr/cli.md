# @vite-hub/cli decisions

Each entry records a decision that the code cannot show. See [README.md](README.md) for the format.

## Retired CLI diagnostic codes are never reused

`cliErrorDiagnostics` in `packages/cli/src/error-diagnostics.ts`.

**Context:** Published diagnostic codes link to docs pages and appear in logs and issues. Four CLI codes were removed; the only record of them was a comment above `cliErrorDiagnostics`.

**Decision:** These codes are retired and must not be reused for another failure: CLI_R0006, SETUP_CONSOLE_INVALID, SETUP_DEPLOY_SECRET_UNSUPPORTED, SETUP_DEPLOY_SECRET_UNVERIFIED.

**Consequences:** A new CLI code must pick another name. Consider adding them to a retired-codes list that test/diagnostic-codes.test.ts checks, so the rule is enforced instead of written down.

## CLI config discovery loads Nuxt with the same envName as nuxt dev and nuxt build

`loadNuxtProject options.envName` in `packages/cli/src/index.ts`.

**Context:** Nuxt picks `$development`/`$production` config from NODE_ENV, which `nuxt dev` and `nuxt build` set and a CLI command does not.

**Decision:** The CLI passes `envName` from `--mode`, else `production` for build and `development` otherwise, when it loads the Nuxt config.

**Consequences:** Without it, discovery resolves another config than the dev server and rewrites its generated files. Removing `envName` is a silent regression.

## Spawned host and package-manager CLIs on Windows run without evaluating batch syntax where possible

`defaultSpawn`, `windowsNodeEntry`, `executableIn` in `packages/cli/src/index.ts`, `packages/cli/src/setup/deploy/host.ts`.

**Context:** Windows `.cmd`/`.bat` shims need a shell, but a shell splits paths with spaces and evaluates batch syntax.

**Decision:** `defaultSpawn` uses a shell on Windows except for `process.execPath`. Host CLIs resolve npm (`%dp0%`) and pnpm/Yarn (`%~dp0`) shims to their Node entry and run that with Node, reading only existing Node files next to the shim.

**Consequences:** Do not switch host CLI runs to `shell: true`; secrets on stdin and argv must not pass through batch parsing.

## CLI commands write to the stdout writer captured before config loading

`runViteHubCli`, `getStableStdoutWrite` in `packages/cli/src/index.ts`.

**Context:** Config loading patches `process.stdout.write` for a while, and another CLI invocation in the same process may own that patch when this command prints.

**Decision:** `runViteHubCli` binds its stdout writer once, before any config loads, through `getStableStdoutWrite()`.

**Consequences:** Writing through `process.stdout.write` later can send `--json` output into another invocation's capture.

## Operation commands never guess a dev server port

`resolveTarget` in `packages/cli/src/operations.ts`.

**Context:** Another project may run on Vite's default port 5173.

**Decision:** A command calls `--url`, else the dev server that wrote `.vitehub/dev-server.json` for this project, else `VITEHUB_DEV_SERVER_URL`, and otherwise fails with CLI_R0005.

**Consequences:** Adding a localhost:5173 fallback would send operations, including destructive ones, to an unrelated app.

## Provision fails closed

`runProvisionCommand`, `provisionForDeploy` in `packages/cli/src/provision.ts`, `packages/cli/src/setup/deploy/provision.ts`.

**Context:** Provision runs in CI. A run without credentials or with a step that could not look up resources would plan nothing and exit 0.

**Decision:** Outside `--dry-run`, provision exits 1 without host credentials, rejects an unreadable state file before any create, and refuses to apply an unchecked plan.

**Consequences:** Missing CI secrets show as a red step instead of a green one, and created resource ids are never lost to an unreadable state file.

## vitehub deploy step order

`runDeploy`, `prepareDeployCheckouts`, `loadCheckoutModule` in `packages/cli/src/setup/deploy.ts`, `packages/cli/src/setup/deploy/checkouts.ts`.

**Context:** Deploy provisions, builds, gates env, writes host state, deploys, and pushes Workspace checkouts. Several steps depend on the ones before.

**Decision:** Provision before the build (the build binds recorded ids). Prepare checkouts only after confirmation, since it imports project code, and only for production, since a preview must not write the shared Workspace ref; a checkout module that resolves but fails to load stops the deploy. The Env gate runs after provision and build and before `env.apply()` and D1 migrations. The rollback target is read before the deploy replaces it.

**Consequences:** Reordering these steps can bind missing ids, push preview content to the shared ref, deploy without the push, or write host env before the gate.

## Cloudflare deploy uploads secrets with the new version

`cloudflareAdapter`, `checkDeployEnv` in `packages/cli/src/setup/deploy/cloudflare.ts`, `packages/cli/src/setup/env.ts`.

**Context:** `wrangler secret put` changes the live Worker at once, and Wrangler inherits omitted secrets from the latest upload, which may be a preview.

**Decision:** Deploy passes secrets through `--secrets-file` as JSON (not dotenv, which expands `$VAR` and lets process env win), and re-supplies every remote secret from the deploying stage; a remote secret without a local value fails with SETUP_DEPLOY_ENV_STAGE_UNSAFE.

**Consequences:** A preview value cannot reach production, and old code never runs with new values.

## Secrets on disk and in child processes never outlive the run

`runHostCli`, `cloudflareAdapter.deploy`, `pullConsoleEnv`, `writeConsoleCredentials` in `packages/cli/src/setup/console-auth.ts`, `packages/cli/src/setup/console-env.ts`, `packages/cli/src/setup/deploy/cloudflare.ts`, `packages/cli/src/setup/deploy/host.ts`.

**Context:** Deploy and env commands hand secrets to host CLIs through temp files and stdin, and save API keys and pulled env files.

**Decision:** A stdin file is unlinked before the secret is written. The secrets file lives in a 0700 mkdtemp folder removed in `finally`, and Ctrl+C waits for that cleanup. Host CLIs run in their own process group, which is escalated to SIGKILL even after the direct child exits, with a bounded wait on pipes. Saved key and env files are written 0600 to a temp file and renamed, so a rename never follows a symlink target.

**Consequences:** Simplifying any of these (shell spawns, a plain writeFile, killing only the child) can leave secret bytes on disk or a host CLI holding them.

## Deno env push accepts a secret only when Deno will store it as secret

`denoEnv.setSecret` in `packages/cli/src/setup/deploy/deno.ts`.

**Context:** `deno deploy env load` decides secrecy from the variable name; omitting `--non-secrets` cannot force a name such as DATABASE_URL to stay secret.

**Decision:** A secret is pushed only when its name ends in a known secret suffix and has no public prefix; otherwise SETUP_ENV_VALUE_UNSUPPORTED asks the developer to set it in Deno Deploy.

**Consequences:** Relaxing the name check would store secrets as readable variables.

## Netlify env push keeps other contexts and refuses masked secrets

`netlifyScopeBody`, `netlifyEnv.setSecret` in `packages/cli/src/setup/deploy/netlify.ts`.

**Context:** PUT replaces every context value of a variable, and Netlify masks secret values of every context except `dev`. A secret cannot have the post-processing scope.

**Decision:** Deploy uses PATCH for one context, and PUT only to add Functions scope or secret storage while carrying the other values; a secret with values in other contexts is refused before any write.

**Consequences:** Switching to PUT or `env:import` would erase values of other contexts.

## Env values go to dotenv files in a form every reader parses the same way

`dotenvLine`, `deno dotenvLine` in `packages/cli/src/setup/console-env.ts`, `packages/cli/src/setup/deploy/deno.ts`.

**Context:** dotenv keeps backslashes in single and backtick quotes, Vite expands `$` in every quote style, and `@std/dotenv` reads single-quoted values as is.

**Decision:** `dotenvLine` escapes `$` and picks a quote the value does not contain, refusing values with `\r`; the Deno line refuses values with a quote or line break.

**Consequences:** A value is either read back exactly or refused; never written in a form that changes on read.

## Env file git check reads the file system, not git, to find a repository

`inGitRepository`, `assertSecretFilesIgnored` in `packages/cli/src/setup/env.ts`.

**Context:** git reports a broken repository the same way as no repository.

**Decision:** `inGitRepository` looks for `.git` (file or folder with HEAD) or GIT_DIR. Inside a repository, a secret whose value reads a tracked or unignored env file (also through `$NAME` and symlinks) is refused, and a git failure refuses; outside, it passes with a warning.

**Consequences:** Asking git alone would let a broken repository pass as no repository.

## Installed-package check ignores NODE_PATH copies

`setupProject installed` in `packages/cli/src/setup/project.ts`.

**Context:** `require.resolve` reads NODE_PATH, and `pnpm exec` points NODE_PATH at the workspace's hoisted packages. Yarn PnP resolves without node_modules.

**Decision:** `installed()` checks node_modules folders, then resolves without evaluating, and rejects a file under a NODE_PATH folder.

**Consequences:** Status and add would report packages as installed that the app cannot import.

## vitehub update copies a direct dependency's specifier into its npm override

`updateWorkspace` in `packages/cli/src/setup/update.ts`.

**Context:** npm rejects an override of a direct dependency with a different specifier (EOVERRIDE).

**Decision:** When a ViteHub package is both a direct dependency and an override, the override gets the same new specifier.

**Consequences:** Updating them independently breaks `npm install`.

## vitehub init scaffolds Nuxt from a pinned starter commit

`nuxtTemplate` in `packages/cli/src/setup/init.ts`.

**Context:** The live `minimal` registry entry of nuxi can change and does not select Nuxt 5.

**Decision:** Init runs `nuxi init` with `gh:nuxt/starter#<commit>` and selects Nuxt 5 explicitly.

**Consequences:** Replacing the pin with the registry entry can scaffold an unsupported Nuxt major.

## Init uses npx for Yarn

`dlx` in `packages/cli/src/setup/init.ts`.

**Context:** Yarn Classic has no `dlx`.

**Decision:** For Yarn, `dlx` runs `npx --yes`; Yarn stays the package manager of the scaffold and the install.

**Consequences:** Switching to `yarn dlx` breaks Yarn Classic users.

## Heavy modules stay off cold paths

`runViteHubCli setup import`, `resolveProvisionArgs`, `realtime agent page()`, `hubRealtime plugin` in `packages/cli/src/index.ts`, `packages/cli/src/provision.ts`, `packages/realtime/src/agent.ts`, `packages/realtime/src/vite.ts`.

**Context:** The setup commands load Babel, semver, and diff; the Realtime server loads Tiptap, ProseMirror, and Yjs.

**Decision:** The CLI imports setup modules only to run a setup command or print root help; provision loads setup only without --host. The Agent `page()` Realtime handle and the Vite plugin do not import the Realtime server.

**Consequences:** A static import here adds the heavy graph to every CLI start, Agent route, and Worker cold start.
