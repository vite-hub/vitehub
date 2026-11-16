import { defineDiagnostics } from "nostics"

const dynamicError = {
  why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
}

// Each code identifies one ViteHub failure site. Keep published codes stable.
// Retired codes. Do not reuse them: CLI_R0006, SETUP_CONSOLE_INVALID, SETUP_DEPLOY_SECRET_UNSUPPORTED, and SETUP_DEPLOY_SECRET_UNVERIFIED.
export const cliErrorDiagnostics = /*#__PURE__*/ defineDiagnostics({
  docsBase: "https://vitehub.dev/docs/development/diagnostics",
  codes: {
    /** A host API answered with a shape that the CLI cannot read. */
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
    /** A setup command failed with an error that has no code, and `--json` reports it. */
    CLI_SETUP_FAILED: {
      fix: "Fix the cause that the message names, then run the command again.",
      why: ({ message }: { message: string }) => message,
    },
    SETUP_CONFIG_NOT_LITERAL: {
      fix: "Write the options as an object literal, such as `vitehub({ kv: true })`, or edit the config by hand.",
      why: ({ file, reason }: { file?: unknown, reason?: unknown }) => `The vitehub() options in ${String(file)} cannot be read without running the config (${String(reason)}).`,
    },
    SETUP_NOT_A_PROJECT: {
      fix: "Run the command in the folder of your Vite or Nuxt app, where its package.json is.",
      why: ({ root }: { root?: unknown }) => `${String(root)} has no package.json, vite.config, or nuxt.config file.`,
    },
    SETUP_CONFIG_MANUAL: {
      fix: ({ snippet }: { snippet?: unknown }) => `Add these keys to the vitehub() options by hand:\n${String(snippet)}`,
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
        ? "Use literal rootDir and serverDir options without layers, or pass --force to turn the features off without checking unresolved Definition files."
        : "Create the Definition in your evaluated Nuxt server directory and rerun without --name, or use literal rootDir and serverDir options without layers.",
      why: "ViteHub cannot determine the Nuxt application server directory without running the config.",
    },
    SETUP_INPUT_NEEDED: {
      fix: "Run the `rerun` command, or pass the missing values with --option.",
      why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
    },
    SETUP_INSTALL_FAILED: {
      fix: ({ filesWritten }: { filesWritten?: unknown }) => `Run the install command by hand to see the error, then run the command again. ${filesWritten === "possible"
        ? "Scaffolding may have left new app files on disk; inspect the target folder before retrying."
        : filesWritten
          ? "The new app files were written before installation failed; keep them when retrying."
          : "ViteHub did not write starter or config files; the package manager may have changed package manifests or lockfiles."}`,
      why: ({ command, exitCode }: { command?: unknown, exitCode?: unknown }) => `\`${String(command)}\` exited with code ${String(exitCode)}.`,
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
      fix: ({ rerun }: { host?: unknown, project?: unknown, account?: unknown, rerun?: unknown }) => `Run \`${String(rerun)}\` to create it, or pass --project with the name of a project that exists.`,
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
    SETUP_INIT_NUXT_VERSION: {
      fix: ({ dir, scaffolded }: { dir?: unknown, scaffolded?: unknown }) => `${scaffolded ? `The scaffold files remain in ${String(dir)}. ` : ""}Set nuxt to a Nuxt 5 version, then run init on that folder again.`,
      why: ({ dir }: { dir?: unknown }) => `${String(dir)} does not declare a known Nuxt 5 version. ViteHub did not adopt it.`,
    },
    SETUP_DEPLOY_HOST_UNSUPPORTED: {
      fix: "Set `host` in vitehub() to cloudflare, vercel, netlify, or deno, or start the Node server from `.output` yourself.",
      why: ({ host }: { host?: unknown }) => `\`vitehub deploy\` has no upload for the ${String(host)} host.`,
    },
    SETUP_DEPLOY_CREDENTIALS_MISSING: {
      fix: ({ fix }: { host?: unknown, fix?: unknown }) => fix === undefined ? "Log in with the host CLI, such as `npx wrangler login`, or set the host token, such as CLOUDFLARE_API_TOKEN, VERCEL_TOKEN, NETLIFY_AUTH_TOKEN, or DENO_DEPLOY_TOKEN, then run the command again." : String(fix),
      why: ({ host }: { host?: unknown, fix?: unknown }) => `No ${String(host)} credentials were found in the environment or in the host CLI login.`,
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
      fix: ({ firstDeploy, host }: { firstDeploy?: unknown, host?: unknown, names?: unknown, stage?: unknown }) => firstDeploy
        ? `Set each name in the shell or in .env.<stage>, then deploy again. If the ${String(host)} project already exists, run \`vitehub link --host ${String(host)}\` first, so deploy reads its variables.`
        : `Run \`vitehub env push --host ${String(host)}\`, set the names in the ${String(host)} dashboard, or set them in the shell or in .env.<stage> and deploy again.`,
      why: ({ firstDeploy, host, names, stage }: { firstDeploy?: unknown, host?: unknown, names?: unknown, stage?: unknown }) => firstDeploy
        ? `The app needs ${String(names)}, and no value was found. This is the first deploy to ${String(host)}: the project is not linked, so the host has no variables yet and every required name needs a local value for the ${String(stage)} stage. Nothing was deployed.`
        : `The app needs ${String(names)}, and neither ${String(host)} nor a local value for the ${String(stage)} stage has one. Nothing was deployed.`,
    },
    SETUP_DEPLOY_ENV_NOT_LINKED: {
      fix: ({ host }: { host?: unknown, names?: unknown }) => `Run \`vitehub link --host ${String(host)} --create\` to create the project, then deploy again.`,
      why: ({ host, names }: { host?: unknown, names?: unknown }) => `The ${String(host)} project is not linked, so deploy cannot set ${String(names)} before the first deploy. Nothing was deployed.`,
    },
    SETUP_DEPLOY_ENV_STAGE_UNSAFE: {
      why: ({ names, stage }: { names?: unknown, stage?: unknown }) => `These existing Cloudflare secrets have no local value for stage ${String(stage)}: ${String(names)}. The latest uploaded version may belong to another stage, so inheriting its values is unsafe. Nothing was deployed.`,
      fix: ({ stage }: { names?: unknown, stage?: unknown }) => `Set every listed name in the shell or an untracked .env.${String(stage)} file and deploy again. Cloudflare deploys re-supply all existing secrets with the version to preserve stage isolation.`,
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
      why: ({ message, url }: { fix?: unknown, message?: unknown, url?: unknown }) => `The app is deployed to ${String(url)}, but the Workspace push failed: ${String(message)}`,
    },
    CLI_R0004: {
      fix: "Run it again with --yes, or check the change first with a dry run when the command has one.",
      why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
    },
    SETUP_ENV_FILE_TRACKED: {
      fix: ({ file }: { file?: unknown, names?: unknown }) => `Run \`git rm --cached ${String(file)}\`, add \`.env*\` to .gitignore, and rotate the values that git has seen. Or set the values in the shell for this command.`,
      why: ({ file, names }: { file?: unknown, names?: unknown }) => `${String(file)} is tracked by git and holds the secret ${String(names)}. \`vitehub env push\` does not push a secret that is in git.`,
    },
    SETUP_ENV_NAME_UNKNOWN: {
      fix: "Pass names that `vitehub env diff` lists, or build again after you declare the name.",
      why: ({ names }: { names?: unknown }) => `The build output lists no variable named ${String(names)}.`,
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
