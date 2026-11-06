import { defineDiagnostics } from "nostics"

const dynamicError = {
  why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
}

// Each code identifies one ViteHub failure site. Keep published codes stable.
export const cliErrorDiagnostics = /*#__PURE__*/ defineDiagnostics({
  docsBase: () => "https://vitehub.dev/docs/reference/diagnostics",
  codes: {
    CLI_R0001: dynamicError,
    CLI_R0002: dynamicError,
    CLI_R0003: {
      fix: "Run the command with --help to see its input.",
      why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
    },
    CLI_R0005: {
      fix: "Start `vite dev` in this project, or pass `--url <origin>` of a running or deployed app. `VITEHUB_DEV_SERVER_URL` also names a server.",
      why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
    },
    CLI_R0006: dynamicError,
    SETUP_CONFIG_NOT_LITERAL: {
      docs: "https://vitehub.dev/docs/development/cli#setup_config_not_literal",
      fix: "Write the options as an object literal, such as `vitehub({ kv: true })`, or edit the config by hand.",
      why: ({ file, reason }: { file?: unknown, reason?: unknown }) => `The vitehub() options in ${String(file)} cannot be read without running the config (${String(reason)}).`,
    },
    SETUP_NOT_A_PROJECT: {
      docs: "https://vitehub.dev/docs/development/cli#setup_not_a_project",
      fix: "Run the command in the folder of your Vite or Nuxt app, where its package.json is.",
      why: ({ root }: { root?: unknown }) => `${String(root)} has no package.json, vite.config, or nuxt.config file.`,
    },
    SETUP_CONFIG_MANUAL: {
      docs: "https://vitehub.dev/docs/development/cli#setup_config_manual",
      fix: ({ snippet }: { snippet?: unknown }) => `Add these keys to the vitehub() options by hand:\n${String(snippet)}`,
      why: ({ file, reason }: { file?: unknown, reason?: unknown }) => `ViteHub cannot edit the vitehub() options in ${String(file)} without running the config (${String(reason)}).`,
    },
    SETUP_FEATURE_UNSUPPORTED: {
      docs: "https://vitehub.dev/docs/development/cli#setup_feature_unsupported",
      fix: "Remove the feature from the command, or set `preset` to a host that supports it. Run `vitehub catalog` to compare hosts.",
      why: ({ detail, feature, host }: { detail?: unknown, feature?: unknown, host?: unknown }) => `${String(feature)} is not supported on the ${String(host)} preset. ${String(detail)}`,
    },
    SETUP_FILE_EXISTS: {
      docs: "https://vitehub.dev/docs/development/cli#setup_file_exists",
      fix: "Choose another --name, or edit the file by hand.",
      why: ({ definition, file, starter }: { definition?: unknown, file?: unknown, starter?: unknown }) => starter === undefined
        ? `${String(file)} exists and is not the starter Definition. ViteHub never overwrites a file.`
        : `${String(file)} already defines a ${String(definition)} Definition that conflicts with ${String(starter)}, so the build would reject both.`,
    },
    SETUP_INPUT_NEEDED: {
      docs: "https://vitehub.dev/docs/development/cli#setup_input_needed",
      fix: "Run the `rerun` command, or pass the missing values with --option.",
      why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
    },
    SETUP_INSTALL_FAILED: {
      docs: "https://vitehub.dev/docs/development/cli#setup_install_failed",
      fix: "Run the install command by hand to see the error, then run the command again. ViteHub did not write starter or config files; the package manager may have changed package manifests or lockfiles.",
      why: ({ command, exitCode }: { command?: unknown, exitCode?: unknown }) => `\`${String(command)}\` exited with code ${String(exitCode)}.`,
    },
    SETUP_STALE_PLAN: {
      docs: "https://vitehub.dev/docs/development/cli#setup_stale_plan",
      fix: "Run the command again to plan from the current file.",
      why: ({ file }: { file?: unknown }) => `${String(file)} changed after ViteHub planned the change.`,
    },
    SETUP_LINK_HOST_UNSUPPORTED: {
      docs: "https://vitehub.dev/docs/development/cli#setup_link_host_unsupported",
      fix: "Pass --host cloudflare, vercel, netlify, or deno, or set `preset` in vitehub().",
      why: ({ host }: { host?: unknown }) => `The ${String(host)} host has no project to link. A self-hosted Node server needs no link.`,
    },
    SETUP_LINK_CREDENTIALS_MISSING: {
      docs: "https://vitehub.dev/docs/development/cli#setup_link_credentials_missing",
      fix: ({ fix }: { host?: unknown, fix?: unknown }) => String(fix),
      why: ({ host }: { host?: unknown, fix?: unknown }) => `No ${String(host)} credentials were found in the environment or in the host CLI login.`,
    },
    SETUP_LINK_ACCOUNT_REQUIRED: {
      docs: "https://vitehub.dev/docs/development/cli#setup_link_account_required",
      fix: "Run the command again with --account <id>, using one of the account ids in `missing`.",
      why: ({ count }: { count?: unknown }) => Number(count) === 0
        ? "The Cloudflare token has access to no account."
        : `The Cloudflare token has access to ${String(count)} accounts, so the account to link is not clear.`,
    },
    SETUP_LINK_NAME_REQUIRED: {
      docs: "https://vitehub.dev/docs/development/cli#setup_link_name_required",
      fix: "Pass --project <name>, or set `name` in vitehub() or in package.json.",
      why: () => "The project name is not known. vitehub() has no literal `name` and package.json has no name.",
    },
    SETUP_LINK_PROJECT_NOT_FOUND: {
      docs: "https://vitehub.dev/docs/development/cli#setup_link_project_not_found",
      fix: ({ rerun }: { host?: unknown, project?: unknown, account?: unknown, rerun?: unknown }) => `Run \`${String(rerun)}\` to create it, or pass --project with the name of a project that exists.`,
      why: ({ host, project, account }: { host?: unknown, project?: unknown, account?: unknown, rerun?: unknown }) => `The ${String(host)} project ${JSON.stringify(String(project))} does not exist${account ? ` in account ${String(account)}` : ""}.`,
    },
    SETUP_INIT_DIR_NOT_EMPTY: {
      docs: "https://vitehub.dev/docs/development/cli#setup_init_dir_not_empty",
      fix: "Choose a new or empty folder, or run `vitehub init` on the folder of a Vite or Nuxt app.",
      why: ({ dir }: { dir?: unknown }) => `${String(dir)} is not empty and holds no Vite or Nuxt app. ViteHub never overwrites a file.`,
    },
    SETUP_INIT_FRAMEWORK_MISMATCH: {
      docs: "https://vitehub.dev/docs/development/cli#setup_init_framework_mismatch",
      fix: ({ found }: { dir?: unknown, found?: unknown, framework?: unknown }) => `Pass --framework ${String(found)}, or choose another folder.`,
      why: ({ dir, found, framework }: { dir?: unknown, found?: unknown, framework?: unknown }) => `${String(dir)} holds a ${String(found)} app, not a ${String(framework)} app.`,
    },
    SETUP_CONSOLE_INVALID: {
      docs: "https://vitehub.dev/docs/development/cli#setup_console_invalid",
      fix: "Copy the command from the Console \"New project\" page again. Never pass the Console token itself.",
      why: () => "--console must be `<pendingId>:sha256:<64 hex characters>`. The value is not printed, because it can hold a secret.",
    },
    SETUP_DEPLOY_HOST_UNSUPPORTED: {
      docs: "https://vitehub.dev/docs/development/cli#setup_deploy_host_unsupported",
      fix: "Set `preset` in vitehub() to cloudflare, vercel, netlify, or deno, or start the Node server from `.output` yourself.",
      why: ({ host }: { host?: unknown }) => `\`vitehub deploy\` has no upload for the ${String(host)} host.`,
    },
    SETUP_DEPLOY_CREDENTIALS_MISSING: {
      docs: "https://vitehub.dev/docs/development/cli#setup_deploy_credentials_missing",
      fix: ({ fix }: { host?: unknown, fix?: unknown }) => String(fix),
      why: ({ host }: { host?: unknown, fix?: unknown }) => `No ${String(host)} credentials were found in the environment or in the host CLI login.`,
    },
    SETUP_DEPLOY_TEMPORARY_UNSUPPORTED: {
      docs: "https://vitehub.dev/docs/development/cli#setup_deploy_temporary_unsupported",
      fix: "Remove --temporary and deploy with your host login.",
      why: ({ reason }: { reason?: unknown }) => `--temporary cannot run here. ${String(reason)}`,
    },
    SETUP_DEPLOY_PREVIEW_UNSUPPORTED: {
      docs: "https://vitehub.dev/docs/development/cli#setup_deploy_preview_unsupported",
      fix: "Remove --preview to deploy to production.",
      why: ({ host }: { host?: unknown }) => `The ${String(host)} deploy that the build writes always deploys to production.`,
    },
    SETUP_DEPLOY_ORG_REQUIRED: {
      docs: "https://vitehub.dev/docs/development/cli#setup_deploy_org_required",
      fix: "Set DENO_DEPLOY_ORG to your Deno Deploy organization, or run `vitehub link --host deno --account <org>`.",
      why: () => "The Deno Deploy organization is not known.",
    },
    SETUP_DEPLOY_BUILD_FAILED: {
      docs: "https://vitehub.dev/docs/development/cli#setup_deploy_build_failed",
      fix: "Fix the build error above and run the command again, or pass --no-build to deploy the output that is there.",
      why: ({ command, exitCode }: { command?: unknown, exitCode?: unknown }) => exitCode === undefined
        ? `package.json has no \`build\` script, so \`${String(command)}\` cannot build the app.`
        : `\`${String(command)}\` exited with code ${String(exitCode)}.`,
    },
    SETUP_DEPLOY_OUTPUT_MISSING: {
      docs: "https://vitehub.dev/docs/development/cli#setup_deploy_output_missing",
      fix: "Build the app with vitehub() for this host, then run the command again without --no-build.",
      why: ({ file }: { file?: unknown }) => `The build output has no ${String(file)}.`,
    },
    SETUP_DEPLOY_HOST_MISMATCH: {
      docs: "https://vitehub.dev/docs/development/cli#setup_deploy_host_mismatch",
      fix: "Build again for the linked host, or run `vitehub unlink` and link the host that the build targets.",
      why: ({ built, host }: { built?: unknown, host?: unknown }) => `The build output is for ${String(built)}, but the project deploys to ${String(host)}.`,
    },
    SETUP_DEPLOY_COMMAND_REJECTED: {
      docs: "https://vitehub.dev/docs/development/cli#setup_deploy_command_rejected",
      fix: "Build again with vitehub(). If you set the deploy command yourself, run it yourself.",
      why: ({ command }: { command?: unknown }) => `The build output names a deploy command that ViteHub did not write, so it does not run it: ${String(command)}`,
    },
    SETUP_DEPLOY_FAILED: {
      docs: "https://vitehub.dev/docs/development/cli#setup_deploy_failed",
      fix: "Read the host output above, fix the cause, and run the command again.",
      why: ({ exitCode, output, step }: { exitCode?: unknown, output?: unknown, step?: unknown }) => `\`${String(step)}\` failed${exitCode === undefined ? "" : ` with exit code ${String(exitCode)}`}.${output ? `\n${String(output)}` : ""}`,
    },
    SETUP_DEPLOY_SECRET_UNVERIFIED: {
      docs: "https://vitehub.dev/docs/development/cli#setup_deploy_secret_unverified",
      fix: "Check the project's environment variables on the host, then run the command again.",
      why: ({ host, name }: { host?: unknown, name?: unknown }) => `${String(name)} was set on ${String(host)}, but the host does not list it. The app was not deployed with the Console link.`,
    },
    SETUP_DEPLOY_SECRET_UNSUPPORTED: {
      docs: "https://vitehub.dev/docs/development/cli#setup_deploy_secret_unsupported",
      fix: "Run the command on Linux or macOS, or set the variable in the host dashboard.",
      why: ({ host, reason }: { host?: unknown, reason?: unknown }) => `ViteHub cannot set the Console secret on ${String(host)} without putting it in a command argument. ${String(reason)}`,
    },
    CLI_R0004: {
      fix: "Run it again with --yes, or check the change first with a dry run when the command has one.",
      why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
    },
  },
})
