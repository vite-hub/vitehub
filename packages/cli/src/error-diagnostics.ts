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
    SETUP_FEATURE_IMPLIED: {
      docs: "https://vitehub.dev/docs/development/cli#setup_feature_implied",
      fix: ({ by, feature }: { by?: unknown, feature?: unknown }) => `Remove ${String(by)} too, or pass --force to write \`${String(feature)}: false\`.`,
      why: ({ by, feature }: { by?: unknown, feature?: unknown }) => `${String(feature)} stays on because ${String(by)} turns it on.`,
    },
    SETUP_FEATURE_IN_USE: {
      docs: "https://vitehub.dev/docs/development/cli#setup_feature_in_use",
      fix: "Delete or move the files in `references`, then run the command again. Pass --force to turn the feature off and keep the files.",
      why: ({ features, references }: { features?: unknown, references?: unknown }) => `The app still uses ${String(features)}:\n${String(references)}`,
    },
    SETUP_UNINSTALL_FAILED: {
      docs: "https://vitehub.dev/docs/development/cli#setup_uninstall_failed",
      fix: "Run the uninstall command by hand to see the error. ViteHub already changed the config and deleted the starter files.",
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
    CLI_R0004: {
      fix: "Run it again with --yes, or check the change first with a dry run when the command has one.",
      why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
    },
  },
})
