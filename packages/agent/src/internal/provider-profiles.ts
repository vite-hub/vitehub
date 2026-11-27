import type { AiGatewayHarness } from "@vite-hub/gateways"

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

/** How a gateway reaches a harness that is not signed in to its own service. */
export interface ProviderHarnessGateway {
  /** True when `chatgpt()` can serve the harness. */
  chatgpt: boolean
  /**
   * How the provider process receives the route: Codex `-c` launch arguments, the `ANTHROPIC_*` variables,
   * an OpenCode config in `OPENCODE_CONFIG_CONTENT`, a Pi `models.json`, a Gemini CLI `settings.json`, or a Kimi Code `config.toml`.
   */
  delivery: "anthropic-env" | "codex-config" | "gemini-settings" | "kimi-config" | "opencode-config" | "pi-models"
  /** The `driver.env` names that a gateway sets. */
  ownedEnv: readonly string[]
}

/** What ViteHub must know to run a harness through the embedded provider runtime. */
export type ProviderHarnessProfile = {
  /** The harness name in messages. */
  displayName: string
  /** The `vite-hub/agent` function that creates the Driver. */
  driverFactory: string
  /** The driver kind in T3 Code, where the provider runtime comes from. */
  t3DriverKind: string
  /** The `provider` value that `@t3tools/provider-runtime` receives. */
  runtimeKind: "acp" | "antigravity" | "claude-code" | "codex" | "cursor" | "fx" | "grok" | "kiro" | "muse" | "opencode" | "pi"
  /** The ACP registry agent that runs the harness when `runtimeKind` is `acp`. The generic `acp` harness takes it from the Driver. */
  agentId?: string
  /** The command to run when no executable is configured or installed. */
  command: string
  /** How to install the harness CLI. */
  install: string
  /** The variables that the harness reads to sign in without a gateway. */
  authEnv: readonly string[]
  /** The variable that moves the harness Home. `inheritHost` passes the host value to the provider process. */
  home?: { env: string, inheritHost: boolean }
  skills?: {
    /** The skill roots that the harness reads in its working directory. */
    workspace: readonly string[]
    /** The skill root that the harness reads in its Home. */
    home: string
    /**
     * How the harness receives a private Skills folder: as an extra skill root, as an added directory that it reads `root` in,
     * or not at all. Without one, the harness reads only the Skills in its working directory or Home.
     */
    extra: { kind: "skill-root" } | { kind: "added-directory", root: string } | { kind: "none" }
  }
  /** The instruction file that the harness reads in its working directory. */
  instructionFile: string
  /** The instruction file that the harness reads in its Home, for a Sandbox run that keeps the checkout unchanged. */
  homeInstructionFile?: string
  /** models.dev providers to read a model price from, in order. */
  pricing: {
    providers: readonly string[]
    /** Price usage only when it reports cache reads, so cached input is not billed at the full input price. */
    requiresCacheReadTokens: boolean
  }
  /** The npm packages that a self-hosted build bundles. Without them, the host must install the harness. */
  runtimePackage?: ProviderRuntimePackage
  /** `cumulative-partitions`: usage events carry thread totals with per-response partitions, as Codex reports them. `per-turn`: each event is one turn. */
  usage: "cumulative-partitions" | "per-turn"
  /** True when `VITEHUB_MODELS=emulate` can serve the harness. */
  modelEmulation: boolean
  /** True when the Driver accepts the Codex options: credentials, credentialProfile, reasoningEffort, reasoningSummary, and workspaceWrite. */
  codexOptions: boolean
} & (
  /** The harness signs in to its own service, so `driver.gateway` cannot serve it. */
  | { signInOnly: true, gateway?: undefined }
  | { signInOnly: false, gateway: ProviderHarnessGateway }
)

const per = { usage: "per-turn", modelEmulation: false, codexOptions: false } as const

/**
 * The profiles of every harness that a provider Driver runs. The keys are the harness IDs of
 * `aiGatewayHarnessRoutes` in `@vite-hub/gateways`, which finds the gateway route of each one.
 * Self-hosted builds bundle the runtime packages in this order.
 */
export const providerHarnessProfiles: Readonly<Record<AiGatewayHarness, ProviderHarnessProfile>> = {
  codex: {
    displayName: "Codex",
    driverFactory: "codexDriver",
    t3DriverKind: "codex",
    runtimeKind: "codex",
    command: "codex",
    install: "npm install -g @openai/codex",
    authEnv: ["OPENAI_API_KEY"],
    home: { env: "CODEX_HOME", inheritHost: true },
    skills: {
      workspace: [".agents/skills", ".codex/skills"],
      home: ".agents/skills",
      extra: { kind: "skill-root" },
    },
    instructionFile: "AGENTS.md",
    homeInstructionFile: ".codex/AGENTS.md",
    signInOnly: false,
    gateway: { chatgpt: true, delivery: "codex-config", ownedEnv: ["T3CODE_CODEX_LAUNCH_ARGS"] },
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
    install: "npm install -g @anthropic-ai/claude-code",
    authEnv: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"],
    home: { env: "CLAUDE_CONFIG_DIR", inheritHost: false },
    skills: {
      workspace: [".claude/skills"],
      home: ".claude/skills",
      extra: { kind: "added-directory", root: ".claude/skills" },
    },
    instructionFile: "CLAUDE.md",
    signInOnly: false,
    gateway: {
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
  gemini: {
    displayName: "Gemini CLI",
    driverFactory: "geminiDriver",
    t3DriverKind: "acpRegistry",
    runtimeKind: "acp",
    agentId: "gemini",
    command: "gemini",
    install: "npm install -g @google/gemini-cli",
    authEnv: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
    home: { env: "GEMINI_CLI_HOME", inheritHost: true },
    skills: { workspace: [".gemini/skills", ".agents/skills"], home: ".gemini/skills", extra: { kind: "none" } },
    instructionFile: "GEMINI.md",
    homeInstructionFile: ".gemini/GEMINI.md",
    signInOnly: false,
    gateway: { chatgpt: false, delivery: "gemini-settings", ownedEnv: ["GEMINI_API_KEY", "GEMINI_CLI_CUSTOM_HEADERS", "GEMINI_CLI_HOME", "GOOGLE_GEMINI_BASE_URL"] },
    pricing: { providers: ["google"], requiresCacheReadTokens: false },
    ...per,
  },
  antigravity: {
    displayName: "Antigravity",
    driverFactory: "antigravityDriver",
    t3DriverKind: "antigravity",
    runtimeKind: "antigravity",
    command: "agy",
    install: "Install the Antigravity CLI (agy) and sign in with Google, or set providerSettings.authMethod and apiKey.",
    authEnv: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
    home: { env: "GEMINI_HOME", inheritHost: true },
    instructionFile: "AGENTS.md",
    signInOnly: true,
    pricing: { providers: ["google"], requiresCacheReadTokens: false },
    ...per,
  },
  opencode: {
    displayName: "OpenCode",
    driverFactory: "opencodeDriver",
    t3DriverKind: "opencode",
    runtimeKind: "opencode",
    command: "opencode",
    install: "npm install -g opencode-ai",
    authEnv: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY"],
    home: { env: "OPENCODE_CONFIG_DIR", inheritHost: true },
    skills: { workspace: [".opencode/skills", ".claude/skills", ".agents/skills"], home: ".config/opencode/skills", extra: { kind: "none" } },
    instructionFile: "AGENTS.md",
    homeInstructionFile: ".config/opencode/AGENTS.md",
    signInOnly: false,
    gateway: { chatgpt: false, delivery: "opencode-config", ownedEnv: ["OPENCODE_CONFIG_CONTENT", "VITEHUB_GATEWAY_API_KEY"] },
    pricing: { providers: [], requiresCacheReadTokens: false },
    ...per,
  },
  cursor: {
    displayName: "Cursor",
    driverFactory: "cursorDriver",
    t3DriverKind: "cursor",
    runtimeKind: "cursor",
    command: "cursor-agent",
    install: "Install @cursor/sdk next to vite-hub/agent and set CURSOR_API_KEY.",
    authEnv: ["CURSOR_API_KEY"],
    home: { env: "CURSOR_CONFIG_DIR", inheritHost: true },
    instructionFile: "AGENTS.md",
    signInOnly: true,
    pricing: { providers: ["cursor"], requiresCacheReadTokens: false },
    ...per,
  },
  grok: {
    displayName: "Grok",
    driverFactory: "grokDriver",
    t3DriverKind: "grok",
    runtimeKind: "grok",
    command: "grok",
    install: "npm install -g @xai-official/grok, then run grok login or set XAI_API_KEY.",
    authEnv: ["XAI_API_KEY"],
    home: { env: "GROK_HOME", inheritHost: true },
    instructionFile: "AGENTS.md",
    signInOnly: true,
    pricing: { providers: ["xai"], requiresCacheReadTokens: false },
    ...per,
  },
  pi: {
    displayName: "Pi",
    driverFactory: "piDriver",
    t3DriverKind: "pi",
    runtimeKind: "pi",
    command: "pi",
    install: "npm install -g @earendil-works/pi-coding-agent",
    authEnv: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY"],
    home: { env: "PI_CODING_AGENT_DIR", inheritHost: true },
    skills: { workspace: [".pi/skills", ".agents/skills"], home: ".pi/agent/skills", extra: { kind: "none" } },
    instructionFile: "AGENTS.md",
    homeInstructionFile: ".pi/agent/AGENTS.md",
    signInOnly: false,
    gateway: { chatgpt: false, delivery: "pi-models", ownedEnv: ["PI_CODING_AGENT_DIR", "VITEHUB_GATEWAY_API_KEY"] },
    pricing: { providers: [], requiresCacheReadTokens: false },
    ...per,
  },
  kimi: {
    displayName: "Kimi Code",
    driverFactory: "kimiDriver",
    t3DriverKind: "acpRegistry",
    runtimeKind: "acp",
    agentId: "kimi-code",
    command: "kimi",
    install: "npm install -g @moonshot-ai/kimi-code",
    authEnv: ["KIMI_MODEL_API_KEY"],
    home: { env: "KIMI_CODE_HOME", inheritHost: true },
    instructionFile: "AGENTS.md",
    signInOnly: false,
    gateway: { chatgpt: false, delivery: "kimi-config", ownedEnv: ["KIMI_CODE_CUSTOM_HEADERS", "KIMI_CODE_HOME", "VITEHUB_GATEWAY_API_KEY"] },
    pricing: { providers: ["moonshotai"], requiresCacheReadTokens: false },
    ...per,
  },
  kiro: {
    displayName: "Kiro",
    driverFactory: "kiroDriver",
    t3DriverKind: "kiro",
    runtimeKind: "kiro",
    command: "kiro-cli",
    install: "Install the Kiro CLI (kiro-cli), then run kiro-cli login or set KIRO_API_KEY.",
    authEnv: ["KIRO_API_KEY"],
    instructionFile: "AGENTS.md",
    signInOnly: true,
    pricing: { providers: [], requiresCacheReadTokens: false },
    ...per,
  },
  fx: {
    displayName: "FX",
    driverFactory: "fxDriver",
    t3DriverKind: "fx",
    runtimeKind: "fx",
    command: "fx",
    install: "Install the fx CLI, then run fx login.",
    authEnv: [],
    home: { env: "FX_HOME", inheritHost: true },
    instructionFile: "AGENTS.md",
    signInOnly: true,
    pricing: { providers: [], requiresCacheReadTokens: false },
    ...per,
  },
  muse: {
    displayName: "Muse",
    driverFactory: "museDriver",
    t3DriverKind: "muse",
    runtimeKind: "muse",
    command: "muse",
    install: "Install the muse CLI, then run muse login or set META_API_KEY.",
    authEnv: ["META_API_KEY"],
    instructionFile: "AGENTS.md",
    signInOnly: true,
    pricing: { providers: [], requiresCacheReadTokens: false },
    ...per,
  },
  acp: {
    displayName: "ACP agent",
    driverFactory: "acpDriver",
    t3DriverKind: "acpRegistry",
    runtimeKind: "acp",
    command: "",
    install: "acpDriver({ agentId }) installs the agent from the ACP registry. Set providerSettings.binaryPath to run an installed copy.",
    authEnv: [],
    instructionFile: "AGENTS.md",
    signInOnly: true,
    pricing: { providers: [], requiresCacheReadTokens: false },
    ...per,
  },
}

/** A harness that a provider Driver runs. */
export type ProviderHarness = AiGatewayHarness

export function isProviderHarness(value: unknown): value is ProviderHarness {
  return typeof value === "string" && Object.hasOwn(providerHarnessProfiles, value)
}

export function providerHarnessProfile(harness: ProviderHarness): ProviderHarnessProfile {
  return providerHarnessProfiles[harness]
}
