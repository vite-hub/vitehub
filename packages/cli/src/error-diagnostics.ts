import { defineDiagnostics } from "nostics"

const dynamicError = {
  why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
}

export const cliErrorDiagnostics = /*#__PURE__*/ defineDiagnostics({
  docsBase: "https://vitehub.dev/docs/cli/diagnostics",
  codes: {
    CLI_CONSOLE_LOGIN_FAILED: {
      fix: "Run `vitehub login` again, and approve the code in the browser within 15 minutes. Pass --console <url> for a self-hosted Console.",
      why: ({ console, message }: { console?: unknown, message?: unknown }) => `Sign-in to ${String(console)} did not finish. ${String(message)}`,
    },
    CLI_CONSOLE_REQUEST_FAILED: {
      fix: ({ fix }: { fix?: unknown }) => typeof fix === "string" ? fix : "Check that you are an owner or admin of the team, and that the key opens the app. Run `vitehub whoami` to see both.",
      why: ({ code, console, message }: { code?: unknown, console?: unknown, message?: unknown }) => `${String(console)} refused the request (${String(code)}). ${String(message)}`,
    },
    CLI_CONSOLE_SIGNED_OUT: {
      fix: "Run `vitehub login`, or set VITEHUB_CONSOLE_TOKEN to an API key from Account settings in the Console.",
      why: ({ console }: { console?: unknown }) => `There is no valid API key for ${String(console)}. The key is missing, expired, or revoked.`,
    },
    CLI_ENV_FILE_EXISTS: {
      fix: ({ file }: { file?: unknown }) => `Pass --yes to replace ${String(file)}, or move it first.`,
      why: ({ file }: { file?: unknown }) => `${String(file)} exists. \`vitehub env pull\` does not replace a file without --yes.`,
    },
    CLI_ENV_FILE_NOT_IGNORED: {
      fix: ({ file, tracked }: { file?: unknown, tracked?: unknown }) => tracked
        ? `Run \`git rm --cached ${String(file)}\` and add \`.env.*\` to .gitignore, then pull again.`
        : `Run \`echo '.env.*' >> .gitignore\`, then pull again.`,
      why: ({ file, tracked }: { file?: unknown, tracked?: unknown }) => tracked
        ? `git tracks ${String(file)}, so the values would be committed.`
        : `${String(file)} is not in .gitignore, so the values could be committed.`,
    },
    CLI_ENV_PULL_FAILED: {
      fix: "Check that the Console stores env values, that the key opens the project, and that you are an owner or admin of the team.",
      why: ({ code, message }: { code?: unknown, message?: unknown }) => `The Console refused the pull (${String(code)}). ${String(message)}`,
    },
    CLI_HOST_RESPONSE_INVALID: {
      fix: "Run the command again. If the error stays, check the status page of the host and update `@vite-hub/cli`.",
      why: ({ host }: { host: string }) => `[vitehub] The ${host} API returned an unexpected response.`,
    },
    CLI_R0001: { ...dynamicError, fix: "Install `nuxt` in the project, such as with `pnpm add nuxt`, then run the command again." },
    CLI_R0002: { ...dynamicError, fix: "Install `@vite-hub/cli` again, such as with `pnpm add -D @vite-hub/cli`." },
    CLI_R0003: {
      fix: "Run the command with --help to see its input.",
      why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
    },
    CLI_R0005: {
      fix: "Start `vite dev` in this project, or pass `--url <origin>` of a running or deployed app. `VITEHUB_DEV_SERVER_URL` also names a server.",
      why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
    },
    CLI_SETUP_FAILED: {
      fix: "Fix the cause that the message names, then run the command again.",
      why: ({ message }: { message: string }) => message,
    },
    CLI_UPDATE_INSTALL_FAILED: {
      fix: ({ command }: { command?: unknown }) => `The package files already name the new versions. Fix the cause that the package manager printed, then run \`${String(command)}\`. To undo the update, restore the changed files with git.`,
      why: ({ command, exitCode }: { command?: unknown, exitCode?: unknown }) => `\`${String(command)}\` exited with code ${String(exitCode)}.`,
    },
    CLI_UPDATE_NO_PACKAGES: {
      fix: "Run `vitehub update` in the folder of the app or of the workspace that installs `vite-hub`. To start, run `pnpm add vite-hub`.",
      why: ({ root }: { root?: unknown }) => `No package.json in ${String(root)} or its workspace packages names \`vite-hub\` or an \`@vite-hub/*\` package with a version or a pkg.pr.new URL.`,
    },
    CLI_UPDATE_PACKAGE_MISSING: {
      fix: ({ target }: { target?: unknown }) => String(target) === "npm"
        ? "Pass --preview <commit> to use a pkg.pr.new build that has these packages, or remove them from package.json."
        : "Pass the commit of a build that has these packages, such as a newer commit of main, or remove them from package.json.",
      why: ({ packages, target }: { packages?: unknown, target?: unknown }) => `The project depends on ${String(packages)}, which ${String(target)} does not have. Nothing was changed.`,
    },
    CLI_UPDATE_REQUEST_FAILED: {
      fix: "Check the network and the npm registry in `npm_config_registry`, then run `vitehub update` again.",
      why: ({ status, url }: { status?: unknown, url?: unknown }) => `The request to ${String(url)} failed (${String(status)}). Nothing was changed.`,
    },
    SETUP_CONFIG_NOT_LITERAL: {
      fix: "Write the options as an object literal, such as `vitehub({ kv: true })`, or edit the config by hand.",
      why: ({ file, reason }: { file?: unknown, reason?: unknown }) => `The vitehub() options in ${String(file)} cannot be read without running the config (${String(reason)}).`,
    },
    SETUP_LOGS_OPTION_MOVED: {
      why: "`observability.logs` is no longer a ViteHub option.",
      fix: "Remove the option from the command. Configure the top-level `logs` key by hand, for example `logs: { source: './server/logs.ts' }` to set `logs.source`.",
    },
    SETUP_NOT_A_PROJECT: {
      fix: "Run the command in the folder of your Vite or Nuxt app, where its package.json is.",
      why: ({ root }: { root?: unknown }) => `${String(root)} has no package.json, vite.config, or nuxt.config file.`,
    },
    SETUP_CONFIG_MANUAL: {
      fix: ({ fix, snippet }: { fix?: string, snippet?: unknown }) => fix ?? `Add these keys to the vitehub() options by hand:\n${String(snippet)}`,
      why: ({ file, reason }: { file?: unknown, reason?: unknown }) => `ViteHub cannot edit the vitehub() options in ${String(file)} without running the config (${String(reason)}).`,
    },
    SETUP_FEATURE_UNSUPPORTED: {
      fix: "Remove the feature from the command, or set `host` to a host that supports it. Run `vitehub catalog` to compare hosts.",
      why: ({ detail, feature, host }: { detail?: unknown, feature?: unknown, host?: unknown }) => `${String(feature)} is not supported on the ${String(host)} host. ${String(detail)}`,
    },
    SETUP_FILE_EXISTS: {
      fix: "Choose another --name, or edit the file by hand.",
      why: ({ definition, file, starter }: { definition?: unknown, file?: unknown, starter?: unknown }) => starter === undefined
        ? `${String(file)} exists and is not the starter Definition. ViteHub never overwrites a file.`
        : `${String(file)} already defines a ${String(definition)} Definition that conflicts with ${String(starter)}, so the build would reject both.`,
    },
    SETUP_SERVER_DIR_MANUAL: {
      fix: ({ command }: { command?: unknown }) => command === "remove"
        ? "Pass --force to turn the features off without checking unresolved Definition files, or use literal directory options without layers or directory overrides."
        : "Create the Definition in your evaluated Nuxt server directory and rerun without --name, or use literal directory options without layers or directory overrides.",
      why: "ViteHub cannot determine the Nuxt application server directory without running the config.",
    },
    SETUP_INPUT_NEEDED: {
      fix: ({ fix }: { fix?: string }) => fix ?? "Run the `rerun` command, or pass the missing values with --option.",
      why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
    },
    SETUP_INSTALL_FAILED: {
      fix: ({ filesWritten, ignored, workspaceFile }: { filesWritten?: unknown, ignored?: readonly string[], workspaceFile?: string }) => `${ignored?.length && workspaceFile
        ? `pnpm stopped at the build scripts of ${ignored.map(name => `\`${name}\``).join(", ")}. Add each one under \`allowBuilds\` in \`${workspaceFile}\`, set to \`false\` to skip its build script or \`true\` to run it, or run \`pnpm approve-builds\`. Then run the command again.`
        : "Read the package manager error above, fix it, then run the command again."} ${filesWritten === "possible"
        ? "Scaffolding may have left new app files on disk; inspect the target folder before retrying."
        : filesWritten
          ? "The new app files were written before installation failed; keep them when retrying."
          : "ViteHub did not write starter or config files; the package manager may have changed package manifests or lockfiles."}`,
      why: ({ command, exitCode, output }: { command?: unknown, exitCode?: unknown, output?: string }) => `\`${String(command)}\` exited with code ${String(exitCode)}.${output ? `\n${output}` : ""}`,
    },
    SETUP_FEATURE_IMPLIED: {
      fix: ({ by, feature }: { by?: unknown, feature?: unknown }) => `Remove ${String(by)} too, or pass --force to write \`${String(feature)}: false\`.`,
      why: ({ by, feature }: { by?: unknown, feature?: unknown }) => `${String(feature)} stays on because ${String(by)} turns it on.`,
    },
    SETUP_FEATURE_REQUIRED: {
      fix: ({ by, feature }: { by?: unknown, feature?: unknown }) => `Remove ${String(by)} too, or change its options before removing ${String(feature)}. --force cannot remove a required feature.`,
      why: ({ by, feature }: { by?: unknown, feature?: unknown }) => `${String(feature)} is required by the configured options of ${String(by)}.`,
    },
    SETUP_FEATURE_IN_USE: {
      fix: "Delete or move the files in `references`, then run the command again. Pass --force to turn the feature off and keep the files.",
      why: ({ features, references }: { features?: unknown, references?: unknown }) => `The app still uses ${String(features)}:\n${String(references)}`,
    },
    SETUP_UNINSTALL_FAILED: {
      fix: ({ configWritten }: { configWritten?: unknown }) => `Run the uninstall command by hand to see the error. ${configWritten === false ? "ViteHub kept the config unchanged; starter files may already be deleted. Plan the removal again after fixing the uninstall." : "ViteHub already changed the config and deleted the starter files."}`,
      why: ({ command, exitCode }: { command?: unknown, exitCode?: unknown }) => `\`${String(command)}\` exited with code ${String(exitCode)}.`,
    },
    SETUP_PLAN_UNKNOWN: {
      fix: "Plan the change again. A plan applies once, and only on the dev server that made it.",
      why: () => "The dev server has no plan with this id. It was applied already, or the server restarted.",
    },
    SETUP_STALE_PLAN: {
      fix: "Run the command again to plan from the current file.",
      why: ({ file }: { file?: unknown }) => `${String(file)} changed after ViteHub planned the change.`,
    },
    SETUP_LINK_HOST_UNSUPPORTED: {
      fix: "Pass --host cloudflare, vercel, netlify, or deno, or set `host` in vitehub().",
      why: ({ host }: { host?: unknown }) => `The ${String(host)} host has no project to link. A self-hosted Node server needs no link.`,
    },
    SETUP_LINK_CREDENTIALS_MISSING: {
      fix: ({ fix }: { host?: unknown, fix?: unknown }) => fix === undefined ? "Log in with the host CLI, such as `npx wrangler login`, or set the host token, such as CLOUDFLARE_API_TOKEN, VERCEL_TOKEN, NETLIFY_AUTH_TOKEN, or DENO_DEPLOY_TOKEN, then run the command again." : String(fix),
      why: ({ host }: { host?: unknown, fix?: unknown }) => `No ${String(host)} credentials were found in the environment or in the host CLI login.`,
    },
    SETUP_LINK_ACCOUNT_REQUIRED: {
      fix: "Run the command again with --account <id>, using one of the account ids in `missing`.",
      why: ({ count }: { count?: unknown }) => Number(count) === 0
        ? "The Cloudflare token has access to no account."
        : `The Cloudflare token has access to ${String(count)} accounts, so the account to link is not clear.`,
    },
    SETUP_LINK_HOST_REQUIRED: {
      fix: ({ command }: { command?: unknown, hosts?: unknown }) => `Run \`${String(command)} --host <host>\`, or make one host the default with \`vitehub link --host <host> --default\`.`,
      why: ({ hosts }: { command?: unknown, hosts?: unknown }) => `The project links several hosts (${String(hosts)}) and none is the default, so the host is not clear.`,
    },
    SETUP_LINK_NAME_REQUIRED: {
      fix: "Pass --project <name>, or set `name` in vitehub() or in package.json.",
      why: () => "The project name is not known. vitehub() has no literal `name` and package.json has no name.",
    },
    SETUP_LINK_PROJECT_NOT_FOUND: {
      fix: ({ host, rerun }: { host?: unknown, project?: unknown, account?: unknown, rerun?: unknown }) => host === "deno"
        ? "Create the app in Deno Deploy first, then run `vitehub link --host deno`, or pass --project with the name of an existing app."
        : `Run \`${String(rerun)}\` to create it, or pass --project with the name of a project that exists.`,
      why: ({ host, project, account }: { host?: unknown, project?: unknown, account?: unknown, rerun?: unknown }) => `The ${String(host)} project ${JSON.stringify(String(project))} does not exist${account ? ` in account ${String(account)}` : ""}.`,
    },
    SETUP_INIT_DIR_NOT_EMPTY: {
      fix: "Choose a new or empty folder, or run `vitehub init` on the folder of a Vite or Nuxt app.",
      why: ({ dir }: { dir?: unknown }) => `${String(dir)} is not empty and holds no Vite or Nuxt app. ViteHub never overwrites a file.`,
    },
    SETUP_INIT_FRAMEWORK_MISMATCH: {
      fix: ({ found }: { dir?: unknown, found?: unknown, framework?: unknown }) => `Pass --framework ${String(found)}, or choose another folder.`,
      why: ({ dir, found, framework }: { dir?: unknown, found?: unknown, framework?: unknown }) => `${String(dir)} holds a ${String(found)} app, not a ${String(framework)} app.`,
    },
    SETUP_INIT_HOST_MIGRATION: {
      fix: "Use the app's current host, or migrate its enabled features, providers and Definitions in the config before running init again.",
      why: ({ host }: { host?: unknown }) => `init cannot change an enabled ViteHub stack to the ${String(host)} host.`,
    },
    SETUP_INIT_NITRO_VERSION: {
      fix: ({ dir, range, scaffolded }: { dir?: unknown, range?: unknown, scaffolded?: unknown }) => `${scaffolded ? `The scaffold files remain in ${String(dir)}. ` : ""}Set nitro to \`${String(range)}\` in each section of package.json that declares it, then run init again.`,
      why: ({ dir, range }: { dir?: unknown, range?: unknown }) => `${String(dir)} declares a Nitro version that init cannot verify against Nuxt 4.7's requirement (${String(range)}). ViteHub did not adopt it.`,
    },
    SETUP_INIT_NUXT_VERSION: {
      fix: ({ dir, scaffolded }: { dir?: unknown, scaffolded?: unknown }) => `${scaffolded ? `The scaffold files remain in ${String(dir)}. ` : ""}Upgrade to Nuxt 4.7 with Nitro 3 (\`pnpm add nuxt@^4.7.0 nitro\`), or set nuxt to a Nuxt 5 version. Then run init on that folder again.`,
      why: ({ dir }: { dir?: unknown }) => `${String(dir)} does not declare a supported Nuxt version. ViteHub needs Nitro 3, which runs on Nuxt 4.7 with the nitro package, or on Nuxt 5. ViteHub did not adopt it.`,
    },
    SETUP_DEPLOY_HOST_UNSUPPORTED: {
      fix: "Set `host` in vitehub() to cloudflare, vercel, netlify, or deno, or start the Node server from `.output` yourself.",
      why: ({ host }: { host?: unknown }) => `\`vitehub deploy\` has no upload for the ${String(host)} host.`,
    },
    SETUP_DEPLOY_CREDENTIALS_MISSING: {
      fix: ({ fix }: { host?: unknown, fix?: unknown }) => fix === undefined ? "Log in with the host CLI, such as `npx wrangler login`, or set the host token, such as CLOUDFLARE_API_TOKEN, VERCEL_TOKEN, NETLIFY_AUTH_TOKEN, or DENO_DEPLOY_TOKEN, then run the command again." : String(fix),
      why: ({ host }: { host?: unknown, fix?: unknown }) => `No ${String(host)} credentials were found in the environment or in the host CLI login.`,
    },
    SETUP_DEPLOY_D1_MIGRATIONS_PENDING: {
      fix: ({ apply }: { apply?: unknown, binding?: unknown, migrations?: unknown }) => `Set \`database.migrateOnDeploy: true\` so that \`vitehub deploy\` applies them before the Worker deploys. Or run \`${String(apply)}\` in the build output folder, then deploy again.`,
      why: ({ binding, migrations }: { apply?: unknown, binding?: unknown, migrations?: unknown }) => `The build has D1 migrations that the remote database of the binding ${String(binding)} has not applied: ${String(migrations)}. The new code would query tables or columns that do not exist yet. Nothing was deployed.`,
    },
    SETUP_DEPLOY_TEMPORARY_UNSUPPORTED: {
      fix: "Remove --temporary and deploy with your host login.",
      why: ({ reason }: { reason?: unknown }) => `--temporary cannot run here. ${String(reason)}`,
    },
    SETUP_DEPLOY_PREVIEW_UNSUPPORTED: {
      fix: "Remove --preview to deploy to production.",
      why: ({ host }: { host?: unknown }) => `The ${String(host)} deploy that the build writes always deploys to production.`,
    },
    SETUP_DEPLOY_ORG_REQUIRED: {
      fix: "Set DENO_DEPLOY_ORG to your Deno Deploy organization, or run `vitehub link --host deno --account <org>`.",
      why: () => "The Deno Deploy organization is not known.",
    },
    SETUP_DEPLOY_BUILD_FAILED: {
      fix: "Fix the build error above and run the command again, or pass --no-build to deploy the output that is there.",
      why: ({ command, exitCode }: { command?: unknown, exitCode?: unknown }) => exitCode === undefined
        ? `package.json has no \`build\` script, so \`${String(command)}\` cannot build the app.`
        : `\`${String(command)}\` exited with code ${String(exitCode)}.`,
    },
    SETUP_DEPLOY_CHECK_FAILED: {
      fix: ({ rollback }: { failed?: unknown, rollback?: unknown, url?: unknown }) => `${String(rollback)} Then fix the app and deploy again. Pass --no-check only when the check itself is wrong.`,
      why: ({ failed, url }: { failed?: unknown, rollback?: unknown, url?: unknown }) => `The app is deployed to ${String(url)}, but a \`deploy.check\` path did not answer with a 2xx status: ${String(failed)}.`,
    },
    SETUP_DEPLOY_OUTPUT_MISSING: {
      fix: "Build the app with vitehub() for this host, then run the command again without --no-build.",
      why: ({ file }: { file?: unknown }) => `The build output has no ${String(file)}.`,
    },
    SETUP_DEPLOY_HOST_MISMATCH: {
      fix: ({ host }: { built?: unknown, host?: unknown }) => `Build again for ${String(host)}: run \`vitehub deploy --host ${String(host)}\` without --no-build.`,
      why: ({ built, host }: { built?: unknown, host?: unknown }) => `The build output is for ${String(built)}, but this deploy goes to ${String(host)}.`,
    },
    SETUP_DEPLOY_COMMAND_REJECTED: {
      fix: "Build again with vitehub(). If you set the deploy command yourself, run it yourself.",
      why: ({ command }: { command?: unknown }) => `The build output names a deploy command that ViteHub did not write, so it does not run it: ${String(command)}`,
    },
    SETUP_DEPLOY_ENV_MISSING: {
      fix: ({ console, firstDeploy, host }: { console?: unknown, firstDeploy?: unknown, host?: unknown, names?: unknown, stage?: unknown }) => (console === true ? "For VITEHUB_CONSOLE_KEY_*, run `vitehub login`, and deploy links the app in the Console and sets its key. " : "") + (firstDeploy
        ? `Set each name in the shell or in .env.<stage>, then deploy again. If the ${String(host)} project already exists, run \`vitehub link --host ${String(host)}\` first, so deploy reads its variables.`
        : `Run \`vitehub env push --host ${String(host)}\`, set the names in the ${String(host)} dashboard, or set them in the shell or in .env.<stage> and deploy again.`),
      why: ({ firstDeploy, host, names, stage }: { console?: unknown, firstDeploy?: unknown, host?: unknown, names?: unknown, stage?: unknown }) => firstDeploy
        ? `The app needs ${String(names)}, and no value was found. This is the first deploy to ${String(host)}: the project is not linked, so the host has no variables yet and every required name needs a local value for the ${String(stage)} stage. Nothing was deployed.`
        : `The app needs ${String(names)}, and neither ${String(host)} nor a local value for the ${String(stage)} stage has one. Nothing was deployed.`,
    },
    SETUP_DEPLOY_ENV_NOT_LINKED: {
      fix: ({ host }: { host?: unknown, names?: unknown }) => host === "deno"
        ? "Create the app in Deno Deploy if needed, run `vitehub link --host deno`, then deploy again."
        : `Run \`vitehub link --host ${String(host)} --create\` to create the project, then deploy again.`,
      why: ({ host, names }: { host?: unknown, names?: unknown }) => `The ${String(host)} project is not linked, so deploy cannot set ${String(names)} before the first deploy. Nothing was deployed.`,
    },
    SETUP_DEPLOY_ENV_STAGE_UNSAFE: {
      why: ({ names, stage }: { names?: unknown, stage?: unknown }) => `These existing Cloudflare secrets have no local value for stage ${String(stage)}: ${String(names)}. The latest uploaded version may belong to another stage, so inheriting its values is unsafe. Nothing was deployed.`,
      fix: ({ console, stage }: { console?: unknown, names?: unknown, stage?: unknown }) => `Set every listed name in the shell or an untracked .env.${String(stage)} file and deploy again. Cloudflare deploys re-supply all existing secrets with the version to preserve stage isolation.${console ? " For a Console key, copy the public value of the existing link, or restore the Console connection with `vitehub login`." : ""}`,
    },
    SETUP_DEPLOY_FAILED: {
      fix: "Read the host output above, fix the cause, and run the command again.",
      why: ({ exitCode, output, step }: { exitCode?: unknown, output?: unknown, step?: unknown }) => `\`${String(step)}\` failed${exitCode === undefined ? "" : ` with exit code ${String(exitCode)}`}.${output ? `\n${String(output)}` : ""}`,
    },
    SETUP_DEPLOYMENTS_NOT_LINKED: {
      fix: ({ host }: { host?: unknown }) => host ? `Run \`vitehub link --host ${String(host)}\`, or deploy once with \`vitehub deploy --host ${String(host)}\`.` : "Run `vitehub link` to link the project to its host, or deploy once with `vitehub deploy`.",
      why: ({ host }: { host?: unknown }) => host ? `The project has no ${String(host)} target in .vitehub/link.json, so the host project to read is not known.` : "The project has no host link in .vitehub/link.json, so the host project to read is not known.",
    },
    SETUP_DEPLOYMENTS_CREDENTIALS_MISSING: {
      fix: ({ fix }: { host?: unknown, fix?: unknown }) => fix === undefined ? "Log in with the host CLI, such as `npx wrangler login`, or set the host token, such as CLOUDFLARE_API_TOKEN, VERCEL_TOKEN, NETLIFY_AUTH_TOKEN, or DENO_DEPLOY_TOKEN, then run the command again." : String(fix),
      why: ({ host }: { host?: unknown, fix?: unknown }) => `No ${String(host)} credentials were found in the environment or in the host CLI login, so the deployments cannot be read.`,
    },
    SETUP_DEPLOYMENTS_ACCOUNT_REQUIRED: {
      fix: "Set CLOUDFLARE_ACCOUNT_ID, or run `vitehub link --host cloudflare --account <id>`.",
      why: ({ host }: { host?: unknown }) => `The ${String(host)} account of the linked project is not known.`,
    },
    SETUP_DEPLOYMENTS_PROJECT_ID_REQUIRED: {
      fix: ({ host }: { host?: unknown }) => `Run \`vitehub link --host ${String(host)}\` to store the project id.`,
      why: ({ host }: { host?: unknown }) => `The ${String(host)} link has no project id, and the ${String(host)} API lists deployments by id.`,
    },
    SETUP_DEPLOY_CHECKOUT_CONFLICT: {
      fix: "Edit each file and remove the conflict markers, or run `vitehub resolve` for a binary file. Then deploy again, or pass --no-push to deploy without the push.",
      why: ({ files }: { files?: unknown }) => `A checkout folder of vitehub.lock has unresolved conflicts, so the Workspace push after the deploy would fail. Nothing was built or deployed: ${String(files)}`,
    },
    SETUP_DEPLOY_CHECKOUT_MODULE_FAILED: {
      fix: "Reinstall the project dependencies and check that the Workspace package is the same version as the CLI. Or pass --no-push to deploy without the push.",
      why: ({ file, message, specifier }: { file?: unknown, message?: unknown, specifier?: unknown }) => `The project installs ${String(specifier)}, but ViteHub cannot load it from ${String(file)}, so it cannot push the checkout folders of vitehub.lock. Nothing was built or deployed: ${String(message)}`,
    },
    SETUP_DEPLOY_PROVISION_NEEDS_BUILD: {
      fix: "Deploy again without --no-build, so the build gets the new ids.",
      why: ({ count }: { count?: unknown, host?: unknown }) => `The deploy must create or change ${String(count)} resources, but --no-build deploys an output that was built without their ids. Nothing was created or deployed.`,
    },
    SETUP_DEPLOY_PROVISION_UNCHECKED: {
      fix: "Set the credential that the reason names and deploy again. Or deploy with --no-provision to skip the resources.",
      why: ({ host, missing, warnings }: { host?: unknown, missing?: unknown, warnings?: unknown }) => `The deploy could not check the ${String(host)} resources of the app, so it created and deployed nothing: ${String(warnings)} ${String(missing)}`,
    },
    SETUP_DEPLOY_PUSH_FAILED: {
      fix: ({ fix }: { fix?: unknown, message?: unknown, url?: unknown }) => `${fix ? `${String(fix)} ` : ""}Then run \`vitehub push\`. Do not deploy again.`,
      why: ({ message, url }: { fix?: unknown, message?: unknown, url?: unknown }) => `The app is deployed${url === undefined ? "" : ` to ${String(url)}`}, but the Workspace push failed: ${String(message)}`,
    },
    CLI_R0004: {
      fix: "Run it again with --yes, or check the change first with a dry run when the command has one.",
      why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
    },
    SETUP_ENV_DECRYPT_FAILED: {
      fix: ({ file, key }: { file?: unknown, key?: unknown, name?: unknown, reason?: unknown }) => `Set ${String(key)} to the private key that encrypted ${String(file)}. Check it with \`dotenvx get -f ${String(file)}\`.`,
      why: ({ file, key, name, reason }: { file?: unknown, key?: unknown, name?: unknown, reason?: unknown }) => `${String(key)} cannot decrypt ${String(name)} in ${String(file)} (${String(reason)}).`,
    },
    SETUP_ENV_FILE_NOT_IGNORED: {
      fix: ({ file }: { file?: unknown, names?: unknown }) => `Add \`.env*\` or \`${String(file)}\` to .gitignore. Or set the values in the shell for this command.`,
      why: ({ file, names }: { file?: unknown, names?: unknown }) => `The secret ${String(names)} reads ${String(file)}, which git does not ignore, so a commit can add it. \`vitehub env push\` pushes a secret only from a file that git ignores.`,
    },
    SETUP_ENV_FILE_TRACKED: {
      fix: ({ file }: { file?: unknown, names?: unknown }) => `Run \`git rm --cached ${String(file)}\`, add \`.env*\` to .gitignore, and rotate the values that git has seen. Or set the values in the shell for this command.`,
      why: ({ file, names }: { file?: unknown, names?: unknown }) => `The secret ${String(names)} reads ${String(file)}, which git tracks, directly or through \`$NAME\` expansion or a symlink. \`vitehub env push\` does not push a secret that is in git.`,
    },
    SETUP_ENV_GIT_FAILED: {
      fix: "Fix the git repository so that `git ls-files` and `git check-ignore` work, then run the command again. Or set the values in the shell for this command.",
      why: ({ file, reason }: { file?: unknown, reason?: unknown }) => `Git could not tell whether it tracks or ignores ${String(file)}, which holds a secret: ${String(reason)}. Nothing was pushed.`,
    },
    SETUP_ENV_KEYS_TRACKED: {
      fix: ({ file }: { file?: unknown }) => `Run \`git rm --cached ${String(file)}\`, add it to .gitignore, and rotate the keys with \`dotenvx rotate\`. Everyone with the repository can decrypt the values until then.`,
      why: ({ file }: { file?: unknown }) => `${String(file)} holds the private keys of the encrypted env files and is tracked by git. \`vitehub env push\` does not decrypt with a key that is in git.`,
    },
    SETUP_ENV_NAME_UNKNOWN: {
      fix: "Pass names that `vitehub env diff` lists, or build again after you declare the name.",
      why: ({ names }: { names?: unknown }) => `The build output lists no variable named ${String(names)}.`,
    },
    SETUP_ENV_PRIVATE_KEY_MISSING: {
      fix: ({ key }: { file?: unknown, key?: unknown, names?: unknown }) => `Set ${String(key)} in the shell, or add it to .env.keys, which git must ignore.`,
      why: ({ file, key, names }: { file?: unknown, key?: unknown, names?: unknown }) => `${String(file)} holds the encrypted ${String(names)}, and ${String(key)} is not set.`,
    },
    SETUP_ENV_STAGE_UNSUPPORTED: {
      fix: ({ host, stage }: { host?: unknown, stage?: unknown }) => stage !== "preview"
        ? "Use --stage production or --stage preview, the stages of `vitehub deploy` and `vitehub deploy --preview`."
        : host === "cloudflare"
          ? "A Worker has one set of secrets for every version. Push production values with --stage production."
          : "`vitehub deploy` deploys this host to production only. Push with --stage production.",
      why: ({ host, stage }: { host?: unknown, stage?: unknown }) => `The ${String(host)} host has no environment for the ${String(stage)} stage.`,
    },
    SETUP_ENV_VALUE_UNSUPPORTED: {
      fix: ({ host }: { host?: unknown, name?: unknown, reason?: unknown }) => `Set this value in the ${String(host)} dashboard.`,
      why: ({ host, name, reason }: { host?: unknown, name?: unknown, reason?: unknown }) => `The value of ${String(name)} cannot go to ${String(host)} without a terminal prompt or argv. ${String(reason)}`,
    },
    SETUP_GITHUB_REPOSITORY_REQUIRED: {
      fix: "Pass --repo owner/name, or add a GitHub remote named origin.",
      why: ({ remote }: { remote?: unknown }) => remote ? `The git remote origin (${String(remote)}) is not a github.com repository.` : "This folder has no git remote named origin.",
    },
    SETUP_GITHUB_REQUEST_FAILED: {
      fix: "Check that the token can write the Actions secrets of the repository, and that the repository and environment exist.",
      why: ({ operation, reason }: { operation?: unknown, reason?: unknown }) => `GitHub refused \`${String(operation)}\`: ${String(reason)}`,
    },
  },
})
