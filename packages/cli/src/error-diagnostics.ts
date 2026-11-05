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
      why: ({ file }: { file?: unknown }) => `${String(file)} exists and is not the starter Definition. ViteHub never overwrites a file.`,
    },
    SETUP_INPUT_NEEDED: {
      docs: "https://vitehub.dev/docs/development/cli#setup_input_needed",
      fix: "Run the `rerun` command, or pass the missing values with --option.",
      why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
    },
    SETUP_INSTALL_FAILED: {
      docs: "https://vitehub.dev/docs/development/cli#setup_install_failed",
      fix: "Run the install command by hand to see the error, then run the command again. No file was changed.",
      why: ({ command, exitCode }: { command?: unknown, exitCode?: unknown }) => `\`${String(command)}\` exited with code ${String(exitCode)}.`,
    },
    SETUP_STALE_PLAN: {
      docs: "https://vitehub.dev/docs/development/cli#setup_stale_plan",
      fix: "Run the command again to plan from the current file.",
      why: ({ file }: { file?: unknown }) => `${String(file)} changed after ViteHub planned the change.`,
    },
    CLI_R0004: {
      fix: "Run it again with --yes, or check the change first with a dry run when the command has one.",
      why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
    },
  },
})
