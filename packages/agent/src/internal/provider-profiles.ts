import type { AiGatewayRoute } from "@vite-hub/gateways"

/** Every harness that a provider Driver can run. Only the harnesses in `providerHarnessProfiles` run today. */
export type KnownProviderHarness =
  | "acp"
  | "antigravity"
  | "claude-code"
  | "codex"
  | "cursor"
  | "fx"
  | "gemini"
  | "grok"
  | "kiro"
  | "muse"
  | "opencode"
  | "pi"

/** A native package of a harness for one host platform. */
export interface ProviderRuntimeTarget {
  /** The executable in the package. Without it, the main package runs the harness. */
  binary?: string
  packageName: string
}

/** The npm packages that a self-hosted build bundles so the host can run the harness. */
export interface ProviderRuntimePackage {
  /** The name in build messages. */
  displayName: string
  packageName: string
  /** The executable: a file in the main package, or the `binary` of the native target package. */
  executable: { kind: "package-file", path: string } | { kind: "target-binary" }
  /** The native packages by `<platform>-<arch>`. When `libc` is true, Linux keys end in `-glibc` or `-musl`. */
  targets: Readonly<Record<string, ProviderRuntimeTarget>>
  libc: boolean
  /** Bundle the main package when its native target is missing. The harness then finds its executable itself. */
  allowMissingTarget: boolean
  includePeerDependencies: boolean
}

/** What ViteHub must know to run a harness through the embedded provider runtime. */
export interface ProviderHarnessProfile {
  /** The harness name in messages. */
  displayName: string
  /** The `vite-hub/agent` function that creates the Driver. */
  driverFactory: string
  /** The driver kind in T3 Code, where the provider runtime comes from. */
  t3DriverKind: string
  /** The `provider` value that `@t3tools/provider-runtime` receives. */
  runtimeKind: string
  /** The command to run when no executable is configured or installed. */
  command: string
  /** The variable that moves the harness Home. `inheritHost` passes the host value to the provider process. */
  home: { env: string, inheritHost: boolean }
  skills: {
    /** The skill roots that the harness reads in its working directory. */
    workspace: readonly string[]
    /** The skill root that the harness reads in its Home. */
    home: string
    /** How the harness receives a private Skills folder: as an extra skill root, or as an added directory that it reads `root` in. */
    extra: { kind: "skill-root" } | { kind: "added-directory", root: string }
  }
  /** The instruction file that the harness reads in its working directory. */
  instructionFile: string
  gateway: {
    /** The `baseURL` key of an AI gateway that serves the harness. */
    route: AiGatewayRoute
    /** True when `chatgpt()` can serve the harness. */
    chatgpt: boolean
    /** How the provider process receives the route: Codex `-c` launch arguments, or the `ANTHROPIC_*` variables. */
    delivery: "anthropic-env" | "codex-config"
    /** The `driver.env` names that a gateway sets. */
    ownedEnv: readonly string[]
  }
  /** models.dev providers to read a model price from, in order. */
  pricing: {
    providers: readonly string[]
    /** Price usage only when it reports cache reads, so cached input is not billed at the full input price. */
    requiresCacheReadTokens: boolean
  }
  runtimePackage: ProviderRuntimePackage
  /** `cumulative-partitions`: usage events carry thread totals with per-response partitions, as Codex reports them. `per-turn`: each event is one turn. */
  usage: "cumulative-partitions" | "per-turn"
  /** True when `VITEHUB_MODELS=emulate` can serve the harness. */
  modelEmulation: boolean
  /** True when the Driver accepts the Codex options: credentials, credentialProfile, reasoningEffort, reasoningSummary, and workspaceWrite. */
  codexOptions: boolean
}

/** The profiles of the harnesses that run today. Self-hosted builds bundle their runtime packages in this order. */
export const providerHarnessProfiles = {
  codex: {
    displayName: "Codex",
    driverFactory: "codexDriver",
    t3DriverKind: "codex",
    runtimeKind: "codex",
    command: "codex",
    home: { env: "CODEX_HOME", inheritHost: true },
    skills: {
      workspace: [".agents/skills", ".codex/skills"],
      home: ".agents/skills",
      extra: { kind: "skill-root" },
    },
    instructionFile: "AGENTS.md",
    gateway: { route: "codex", chatgpt: true, delivery: "codex-config", ownedEnv: ["T3CODE_CODEX_LAUNCH_ARGS"] },
    pricing: { providers: ["codex", "openai"], requiresCacheReadTokens: true },
    runtimePackage: {
      displayName: "Codex",
      packageName: "@openai/codex",
      executable: { kind: "package-file", path: "bin/codex.js" },
      targets: {
        "darwin-arm64": { packageName: "@openai/codex-darwin-arm64" },
        "darwin-x64": { packageName: "@openai/codex-darwin-x64" },
        "linux-arm64": { packageName: "@openai/codex-linux-arm64" },
        "linux-x64": { packageName: "@openai/codex-linux-x64" },
      },
      libc: false,
      allowMissingTarget: false,
      includePeerDependencies: false,
    },
    usage: "cumulative-partitions",
    modelEmulation: true,
    codexOptions: true,
  },
  "claude-code": {
    displayName: "Claude Code",
    driverFactory: "claudeCodeDriver",
    t3DriverKind: "claudeAgent",
    runtimeKind: "claude-code",
    command: "claude",
    home: { env: "CLAUDE_CONFIG_DIR", inheritHost: false },
    skills: {
      workspace: [".claude/skills"],
      home: ".claude/skills",
      extra: { kind: "added-directory", root: ".claude/skills" },
    },
    instructionFile: "CLAUDE.md",
    gateway: {
      route: "claude-code",
      chatgpt: false,
      delivery: "anthropic-env",
      ownedEnv: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_CUSTOM_HEADERS"],
    },
    pricing: { providers: ["claude-code", "anthropic"], requiresCacheReadTokens: true },
    runtimePackage: {
      displayName: "Claude",
      packageName: "@anthropic-ai/claude-agent-sdk",
      executable: { kind: "target-binary" },
      targets: {
        "darwin-arm64": { binary: "claude", packageName: "@anthropic-ai/claude-agent-sdk-darwin-arm64" },
        "darwin-x64": { binary: "claude", packageName: "@anthropic-ai/claude-agent-sdk-darwin-x64" },
        "linux-arm64-glibc": { binary: "claude", packageName: "@anthropic-ai/claude-agent-sdk-linux-arm64" },
        "linux-arm64-musl": { binary: "claude", packageName: "@anthropic-ai/claude-agent-sdk-linux-arm64-musl" },
        "linux-x64-glibc": { binary: "claude", packageName: "@anthropic-ai/claude-agent-sdk-linux-x64" },
        "linux-x64-musl": { binary: "claude", packageName: "@anthropic-ai/claude-agent-sdk-linux-x64-musl" },
      },
      libc: true,
      allowMissingTarget: true,
      includePeerDependencies: true,
    },
    usage: "per-turn",
    modelEmulation: false,
    codexOptions: false,
  },
} as const

type CheckedProfiles<T extends Partial<Record<KnownProviderHarness, ProviderHarnessProfile>> & Record<Exclude<keyof T, KnownProviderHarness>, never>> = T

/** A harness that a provider Driver runs today. */
export type ProviderHarness = keyof CheckedProfiles<typeof providerHarnessProfiles>

/** The `provider` values that the embedded provider runtime receives. */
export type ProviderRuntimeKind = (typeof providerHarnessProfiles)[ProviderHarness]["runtimeKind"]

export function isProviderHarness(value: unknown): value is ProviderHarness {
  return typeof value === "string" && Object.hasOwn(providerHarnessProfiles, value)
}

export function providerHarnessProfile(harness: ProviderHarness): ProviderHarnessProfile {
  return providerHarnessProfiles[harness]
}
