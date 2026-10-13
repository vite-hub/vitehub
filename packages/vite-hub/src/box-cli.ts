import { parseArgs } from "node:util";

import type { ViteHubCliCommandNamespace, ViteHubCliContext } from "@vite-hub/internal/cli";

const serveUsage =
  "vitehub box serve --user <name> --host-key <file> --authorized-key <file> [--host <address>] [--port <port>] [--cwd <dir>]";
const checkUsage =
  "vitehub box check --user <name> --identity-file <file> [--host-key-file <file> | --known-hosts-file <file>] [--host <address>] [--port <port>] [--driver <codex|claude-code>] [--timeout <ms>]";

type Values = Record<string, string | boolean | undefined>;

function option(
  values: Values,
  name: string,
  env: NodeJS.ProcessEnv,
  ...fallbacks: string[]
): string | undefined {
  const value = values[name];
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- parseArgs returns strings for string options.
  if (typeof value === "string" && value) return value;
  for (const key of fallbacks) {
    if (env[key]) return env[key];
  }
  return undefined;
}

function required(
  values: Values,
  name: string,
  env: NodeJS.ProcessEnv,
  ...fallbacks: string[]
): string {
  const value = option(values, name, env, ...fallbacks);
  if (!value)
    throw new TypeError(
      `[vitehub] --${name}${fallbacks.length ? ` or ${fallbacks.join(" or ")}` : ""} is required.`,
    );
  return value;
}

function port(values: Values, env: NodeJS.ProcessEnv): number {
  const value = Number(option(values, "port", env, "CRABBOX_STATIC_PORT", "SSH_PORT") ?? 2222);
  if (!Number.isInteger(value) || value < 1 || value > 65535)
    throw new TypeError("[vitehub] --port must be between 1 and 65535.");
  return value;
}

function parse(
  args: string[],
  options: Record<string, { type: "string" | "boolean"; short?: string }>,
): Values | undefined {
  const { values } = parseArgs({
    args,
    options: { ...options, help: { type: "boolean", short: "h" } },
    strict: true,
    allowPositionals: false,
  });
  return values.help ? undefined : values;
}

async function serve(args: string[], context: ViteHubCliContext): Promise<number> {
  const values = parse(args, {
    "authorized-key": { type: "string" },
    cwd: { type: "string" },
    host: { type: "string" },
    "host-key": { type: "string" },
    port: { type: "string" },
    user: { type: "string" },
  });
  if (!values) {
    context.stdout.write(
      `Usage: ${serveUsage}\n\nServe authenticated SSH commands from this machine. It is not a sandbox.\n`,
    );
    return 0;
  }
  const { env } = context;
  const { serveSsh } = await import("@vite-hub/box/ssh");
  const server = await serveSsh({
    authorizedKeyFile: required(values, "authorized-key", env, "SSH_AUTHORIZED_KEY"),
    cwd: option(values, "cwd", env, "RUNNER_WORKSPACE") ?? context.cwd,
    host: option(values, "host", env) ?? "127.0.0.1",
    hostKeyFile: required(values, "host-key", env, "SSH_HOST_KEY"),
    port: port(values, env),
    user: required(values, "user", env, "CRABBOX_STATIC_USER"),
  });
  context.stdout.write(`${JSON.stringify({ event: "box.listening", port: server.port })}\n`);
  return await new Promise<number>((resolve) => {
    const close = () => {
      for (const signal of ["SIGINT", "SIGTERM"] as const) process.off(signal, close);
      server.close().then(
        () => resolve(0),
        () => resolve(1),
      );
    };
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, close);
  });
}

async function check(args: string[], context: ViteHubCliContext): Promise<number> {
  const values = parse(args, {
    driver: { type: "string" },
    host: { type: "string" },
    "host-key-file": { type: "string" },
    "identity-file": { type: "string" },
    "known-hosts-file": { type: "string" },
    port: { type: "string" },
    timeout: { type: "string" },
    user: { type: "string" },
  });
  if (!values) {
    context.stdout.write(
      `Usage: ${checkUsage}\n\nStart the provider Driver through the SSH runner and report its readiness. Codex reads CODEX_AUTH_JSON when set. Set CLIPROXY_URL and CLIPROXY_API_KEY to route either Driver through CLIProxyAPI.\n`,
    );
    return 0;
  }
  const { env } = context;
  const driver = option(values, "driver", env) ?? "codex";
  if (driver !== "codex" && driver !== "claude-code")
    throw new TypeError("[vitehub] --driver must be codex or claude-code.");
  const timeout = Number(option(values, "timeout", env) ?? 25_000);
  if (!Number.isInteger(timeout) || timeout < 1)
    throw new TypeError("[vitehub] --timeout must be a positive number of milliseconds.");
  const [{ defineAgent }, { cliproxy }, { createAgentStatusReader }, { sshLaunch }] = await Promise.all([
    import("@vite-hub/agent"),
    import("@vite-hub/agent/gateways"),
    import("@vite-hub/agent/server"),
    import("@vite-hub/box/ssh"),
  ]);
  // Read the key from the supplied environment only, so an ambient key cannot select an account.
  const gateway = env.CLIPROXY_URL?.trim()
    ? cliproxy({ url: env.CLIPROXY_URL, apiKey: env.CLIPROXY_API_KEY ?? "" })
    : undefined;
  const hostKeyFile = option(values, "host-key-file", env, "SSH_HOST_PUBLIC_KEY");
  const knownHostsFile = option(values, "known-hosts-file", env);
  const ssh = sshLaunch({
    // Keep application filesystem paths and PATH out of the runner environment.
    // Gateway variables are required provider environment, which the runner forwards.
    forwardEnvironment: ["CODEX_AUTH_JSON"],
    host: option(values, "host", env, "CRABBOX_STATIC_HOST") ?? "127.0.0.1",
    identityFile: required(values, "identity-file", env, "CRABBOX_SSH_KEY"),
    port: port(values, env),
    user: required(values, "user", env, "CRABBOX_STATIC_USER"),
    ...(hostKeyFile ? { hostKeyFile } : {}),
    ...(knownHostsFile ? { knownHostsFile } : {}),
  });
  const remoteProbe = String.raw`
umask 077
temporary_root=$TMPDIR
if [ -z "$temporary_root" ]; then temporary_root=/tmp; fi
workspace=$(mktemp -d "$temporary_root/vitehub-box-check.XXXXXX") || exit 1
trap 'rm -rf "$workspace"' EXIT
trap 'exit 1' HUP INT TERM
cd "$workspace" || exit 1
if [ -n "$CODEX_AUTH_JSON" ]; then
  mkdir "$workspace/codex" || exit 1
  printf '%s' "$CODEX_AUTH_JSON" > "$workspace/codex/auth.json" || exit 1
  printf '%s\n' 'cli_auth_credentials_store = "file"' > "$workspace/codex/config.toml" || exit 1
  export CODEX_HOME="$workspace/codex"
  unset CODEX_AUTH_JSON
fi
"$@"
`;
  // Inspection paths and executable resolution belong to the runner, not the application.
  const launch = (launchContext: Parameters<typeof ssh>[0]) => {
    const definition = ssh({ ...launchContext, command: "/bin/sh", cwd: "." });
    return {
      ...definition,
      args: [
        ...definition.args,
        "-c",
        remoteProbe,
        "vitehub-box-check",
        driver === "codex" ? "codex" : "claude",
      ],
    };
  };
  const agent = defineAgent({
    name: "vitehub-box-check",
    driver:
      driver === "codex"
        ? {
            kind: "codex",
            launch,
            env: { CODEX_AUTH_JSON: env.CODEX_AUTH_JSON },
            ...(gateway ? { gateway } : {}),
          }
        : { kind: "claude-code", launch, ...(gateway ? { gateway } : {}) },
  });
  const { authenticated, installed, readiness, reason } = await createAgentStatusReader({
    timeoutMs: timeout,
  })(agent, "vitehub-box-check");
  context.stdout.write(
    `${JSON.stringify({ event: "box.check", driver, readiness, installed, authenticated, reason })}\n`,
  );
  // A completed account probe proves that the transport and provider protocol work. Quota and sign-in state are reported, not failed.
  // A gateway has no provider account, so authentication stays unknown. The probe must still finish without a provider error.
  return installed === true && (authenticated !== undefined || (gateway !== undefined && readiness !== "unavailable")) ? 0 : 1;
}

/** Commands that run inside a Box runner container, without the project config. */
export function createBoxCliNamespace(): ViteHubCliCommandNamespace {
  return {
    description: "Serve and check an SSH Box runner. Does not load the project config.",
    features: [
      {
        description: "Serve authenticated SSH commands for provider Drivers.",
        name: "serve",
        run: serve,
        usage: serveUsage,
      },
      {
        description: "Check that a provider Driver starts through the SSH runner.",
        name: "check",
        run: check,
        usage: checkUsage,
      },
    ],
    name: "box",
  };
}
