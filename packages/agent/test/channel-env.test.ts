import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import { builtInChannelEnv, channelEnvValue } from "../src/channel-env.ts"
import { discoverAgentChannelEnv, discoverBuiltInChannelUses } from "../src/channel-env-discovery.ts"
import { hasRuntimeType } from "../src/internal/runtime-type.ts"
import { ViteHubError } from "@vite-hub/runtime"

const kinds = Object.keys(builtInChannelEnv)

function uses(source: string) {
  return discoverBuiltInChannelUses(source, kinds).map(({ kind, optionKeys }) => ({ kind, keys: optionKeys && [...optionKeys].sort() }))
}

describe("built-in Channel discovery", () => {
  it.each(["tele\\u0067ram", "tele\\u{67}ram", "\\u0074elegram"])("decodes escaped identifier Channel keys: %s", (key) => {
    expect(uses(`
      import { defineAgent } from "vite-hub/agent"
      export default defineAgent({ channels: { ${key}: {} } })
    `)).toEqual([{ kind: "telegram", keys: [] }])
  })

  it.each(["as AgentOptions && actual", "satisfies AgentOptions || actual", "as AgentOptions ?? actual", "as AgentOptions ? actual : selected", "satisfies AgentOptions ? actual : selected"])("rejects runtime operations after unparenthesized settings assertions: %s", (expression) => {
    expect(uses(`
      import { defineAgent } from "vite-hub/agent"
      const selected = { channels: { github: {} } }
      const actual = { channels: { telegram: {} } }
      export default defineAgent(selected ${expression})
    `)).toEqual([])
  })

  it("keeps conditional types in assertions", () => {
    expect(uses(`
      import { telegram } from "vite-hub/agent/channels"
      telegram(({} as T extends U ? A : B))
    `)).toEqual([{ kind: "telegram", keys: [] }])
  })

  it("rejects runtime conditionals after a completed conditional type assertion", () => {
    expect(uses(`
      import { telegram } from "vite-hub/agent/channels"
      telegram({ botToken: token } as T extends U ? A : B ? dynamicOptions : fallback)
    `)).toEqual([{ kind: "telegram", keys: undefined }])
  })

  it.each(["-", "+", "*", "/", "%", "**", "<", "<=", ">", ">=", "==", "===", "!=", "!==", "<<", ">>", ">>>", "^", "in", "instanceof", "&&", "||", "??"])("rejects runtime %s after Channel option assertions", (operator) => {
    for (const assertion of ["as", "satisfies"]) {
      for (const type of ["TelegramChannelOptions", "Options<Runtime>"]) {
        expect(uses(`
          import { telegram } from "vite-hub/agent/channels"
          telegram({} ${assertion} ${type} ${operator} dynamicOptions)
        `)).toEqual([{ kind: "telegram", keys: undefined }])
      }
    }
  })

  it.each(["TelegramChannelOptions", "Options<Runtime>"])("rejects subtraction of a numeric literal after assertion to %s", (type) => {
    expect(uses(`
      import { telegram } from "vite-hub/agent/channels"
      telegram({} as ${type} - 1)
    `)).toEqual([{ kind: "telegram", keys: undefined }])
  })

  it.each(["Options<Runtime>", "Options<() => Runtime>", "A | B", "A & B", "-1 | -2", "() => -1", "{ [K in keyof T]-?: T[K] }", "{ [K in keyof T]+?: T[K] }"])("preserves assertion type syntax: %s", (type) => {
    expect(uses(`
      import { telegram } from "vite-hub/agent/channels"
      telegram({} as ${type})
    `)).toEqual([{ kind: "telegram", keys: [] }])
  })

  it("finds factory calls imported from the Channels module", () => {
    expect(uses(`
      import { defineAgent } from "vite-hub/agent"
      import { telegram, github as gh } from "vite-hub/agent/channels"
      export default defineAgent({
        channels: {
          bot: telegram({ mode: "webhook", "userName": "support" }),
          repo: gh(),
        },
      })
    `)).toEqual([
      { kind: "telegram", keys: ["mode", "userName"] },
      { kind: "github", keys: [] },
    ])
  })

  it("finds namespace calls and object shorthands", () => {
    expect(uses(`
      import { defineAgent } from "vite-hub/agent"
      import * as channels from "@vite-hub/agent/channels"
      export default defineAgent({
        channels: {
          discord: channels.discord({ adapter: true }),
          telegram: { botToken: () => token(), webhookSecret: false },
          github: options,
          http: {},
        },
      })
    `)).toEqual([
      { kind: "discord", keys: ["adapter"] },
      { kind: "telegram", keys: ["botToken", "webhookSecret"] },
      { kind: "github", keys: undefined },
    ])
  })

  it("finds bracketed namespace factory calls", () => {
    expect(uses(`
      import { defineAgent } from "vite-hub/agent"
      import * as channels from "vite-hub/agent/channels"
      export default defineAgent({ channels: { telegram: channels["telegram"]() } })
    `)).toEqual([{ kind: "telegram", keys: [] }])
  })

  it.each(["tele\\u0067ram", "tele\\x67ram", "tele\\u{67}ram"])("decodes escaped namespace factory members: %s", (member) => {
    expect(uses(`
      import { defineAgent } from "vite-hub/agent"
      import * as channels from "vite-hub/agent/channels"
      defineAgent({ channels: { support: channels["${member}"]() } })
      defineAgent({ channels: { support: channels["${member}"] } })
      defineAgent({ channels: { support: channels?.["${member}"]<Runtime>() } })
    `)).toEqual(Array.from({ length: 3 }, () => ({ kind: "telegram", keys: [] })))
  })

  it("recognizes only single parenthesized bare factory references", () => {
    expect(uses(`
      import { defineAgent } from "vite-hub/agent"
      import { telegram } from "vite-hub/agent/channels"
      import * as factories from "vite-hub/agent/channels"
      defineAgent({ channels: { support: (telegram), other: ((factories["telegram"])), typed: (telegram<Runtime>) } })
      defineAgent({ channels: { support: (telegram, custom), other: (telegram || custom) } })
      function build(telegram) { return defineAgent({ channels: { support: (telegram) } }) }
    `)).toEqual(Array.from({ length: 3 }, () => ({ kind: "telegram", keys: [] })))
  })

  it("distinguishes JavaScript comparisons from TypeScript generic calls", () => {
    const source = `
      import { telegram } from "vite-hub/agent/channels"
      telegram < Runtime > ({ botToken: token })
    `
    expect(discoverBuiltInChannelUses(source, kinds, { typescript: false })).toEqual([])
    expect(uses(source)).toEqual([{ kind: "telegram", keys: ["botToken"] }])
  })

  it("finds generic bare factory references by their imported kind", () => {
    expect(uses(`
      import { defineAgent } from "vite-hub/agent"
      import { telegram as bot } from "vite-hub/agent/channels"
      import * as channels from "vite-hub/agent/channels"
      export default defineAgent({ channels: {
        support: bot<Runtime>,
        discord: channels.telegram<Map<string, (value: string) => void>>,
        repo: channels["github"]<Runtime>,
        explicit: bot<Runtime>({ botToken: token }),
      } })
    `)).toEqual([
      { kind: "telegram", keys: [] },
      { kind: "telegram", keys: [] },
      { kind: "github", keys: [] },
      { kind: "telegram", keys: ["botToken"] },
    ])
  })

  it.each(["override", "public override"])("ignores %s method declarations but preserves calls in their bodies", (modifier) => {
    expect(uses(`
      import { telegram } from "vite-hub/agent/channels"
      class Base { telegram() {} }
      class Derived extends Base {
        ${modifier} telegram() { telegram({ botToken: token }) }
      }
    `)).toEqual([{ kind: "telegram", keys: ["botToken"] }])
  })

  it.each(["@memo()", "@cache.memo({ enabled: true })", "@memo", "@memo() @trace()", "@memo<Options>()", "@memo<Map<string, () => void>>()"])("ignores decorated method declarations: %s", (decorator) => {
    expect(uses(`
      import { telegram } from "vite-hub/agent/channels"
      class Helper {
        ${decorator} telegram() { telegram({ botToken: token }) }
      }
    `)).toEqual([{ kind: "telegram", keys: ["botToken"] }])
  })

  it("ignores method declarations while keeping calls inside method bodies", () => {
    expect(uses(`
      import { telegram } from "vite-hub/agent/channels"
      interface Tools { telegram(): void; telegram<T>(options: T): void }
      interface MoreTools {
        other(): void
        telegram(): void
      }
      type Helpers = { telegram(): void }
      const helpers = {
        telegram() {},
        async telegram() {},
        *telegram() {},
        run() { return telegram({ botToken: token }) },
      }
      class ToolsImpl {
        telegram() {}
        #telegram() {}
        async #telegramAsync() {}
        runPrivate() { this.#telegram() }
        static telegram<T>(): void {}
        run() { telegram() }
      }
      const selected = enabled ? await
        telegram({ adapter }) : fallback
    `)).toEqual([
      { kind: "telegram", keys: ["botToken"] },
      { kind: "telegram", keys: [] },
      { kind: "telegram", keys: [] },
    ])
  })

  it.each(["private", "protected", "public", "readonly", "private readonly", "public override readonly"])("treats %s constructor parameter properties as local bindings", (modifier) => {
    expect(uses(`
      import { telegram } from "vite-hub/agent/channels"
      class Runner {
        constructor(${modifier} telegram: () => void) { telegram() }
        run() { telegram() }
      }
    `)).toEqual([{ kind: "telegram", keys: [] }])
  })

  it.each([
    "enabled ? configuredToken : undefined",
    "enabled ? undefined : configuredToken",
    "enabled ? configuredToken : (void 0)",
    "config?.token",
    "config?.[key]",
    "configuredToken ?? undefined",
    "(enabled ? configuredToken : undefined)",
    "enabled ? configuredToken ?? fallback : undefined",
    "enabled && undefined",
    "void configuredToken",
    "void getToken()",
    "void config?.token",
    "void (configuredToken + suffix)",
    "(void configuredToken)",
    "void +configuredToken",
    "void new Token()",
  ])("requires Env when botToken can be undefined: %s", (token) => {
    expect(uses(`
      import { defineAgent } from "vite-hub/agent"
      import { telegram } from "vite-hub/agent/channels"
      telegram({ botToken: ${token} })
      defineAgent({ channels: { telegram: { botToken: ${token} } } })
    `)).toEqual([{ kind: "telegram", keys: [] }, { kind: "telegram", keys: [] }])
  })

  it("preserves supplied tokens with undefined inside call arguments", () => {
    expect(uses(`
      import { telegram } from "vite-hub/agent/channels"
      telegram({ botToken: getToken(undefined) })
      telegram({ botToken: config?.token ?? configuredToken })
      telegram({ botToken: config?.token ? configuredToken : fallback })
      telegram({ botToken: config?.token || configuredToken })
    `)).toEqual(Array.from({ length: 4 }, () => ({ kind: "telegram", keys: ["botToken"] })))
  })

  it.each(["(undefined) + 'suffix'", "(config?.token) + '-suffix'", "(undefined) * 2", "!(config?.token)", "void configuredToken + 'suffix'"])("preserves defined values around grouped or void operands: %s", (token) => {
    expect(uses(`
      import { defineAgent } from "vite-hub/agent"
      import { telegram } from "vite-hub/agent/channels"
      telegram({ botToken: ${token} })
      defineAgent({ channels: { telegram: { botToken: ${token} } } })
    `)).toEqual([{ kind: "telegram", keys: ["botToken"] }, { kind: "telegram", keys: ["botToken"] }])
  })

  it("unwraps asserted bare Channel factories and treats optional accessors as omitted", () => {
    expect(uses(`
      import { defineAgent } from "vite-hub/agent"
      import { telegram } from "vite-hub/agent/channels"
      defineAgent({ channels: { support: <AgentChannelFactory>telegram } })
      telegram({ get botToken(): string | undefined { return configuredToken } })
    `)).toEqual([{ kind: "telegram", keys: [] }, { kind: "telegram", keys: [] }])
  })

  it("recognizes static computed Channel and option keys", () => {
    expect(uses(`
      import { defineAgent } from "vite-hub/agent"
      defineAgent({ channels: { ["telegram"]: {} } })
      defineAgent({ channels: { ['telegram']: { ["botToken"]: token } } })
      defineAgent({ channels: { ['telegram']: { get ["botToken"]() { return undefined } } } })
    `)).toEqual([{ kind: "telegram", keys: [] }, { kind: "telegram", keys: ["botToken"] }, { kind: "telegram", keys: [] }])
  })

  it("decodes escaped static Channel keys", () => {
    expect(uses(`
      import { defineAgent } from "vite-hub/agent"
      defineAgent({ channels: { ["tele\\u0067ram"]: {} } })
    `)).toEqual([{ kind: "telegram", keys: [] }])
  })

  it("treats method and constructor parameters as shadowing imports", () => {
    expect(uses(`
      import { telegram } from "vite-hub/agent/channels"
      const helpers = {
        run(telegram: () => void): { result: string } { return telegram() },
      }
      class Runner {
        constructor(telegram: () => void) { telegram() }
        run() { return telegram() }
      }
      telegram({ botToken: token })
    `)).toEqual([{ kind: "telegram", keys: [] }, { kind: "telegram", keys: ["botToken"] }])
  })

  it("keeps method parameter shadows through arrow-function return types", () => {
    expect(uses(`
      import { telegram } from "vite-hub/agent/channels"
      const helpers = {
        run(telegram: () => void): () => { ready: boolean } { telegram() },
        nested(telegram: () => void): () => () => { ready: boolean } { telegram() },
      }
      class Runner {
        run(telegram: () => void): () => { ready: boolean } { telegram() }
      }
      telegram({ botToken: token })
    `)).toEqual([{ kind: "telegram", keys: ["botToken"] }])
  })

  it("ignores methods after nested class heritage expressions", () => {
    expect(uses(`
      import { telegram } from "vite-hub/agent/channels"
      class Tools extends mixin({ feature: true }) {
        telegram() {}
      }
      const present = "telegram" in { telegram() {} }
      type Conditional<T> = T extends { telegram(): void } ? true : false
    `)).toEqual([])
  })

  it("treats bare arrow parameters as shadowing imports", () => {
    expect(uses(`
      import { telegram } from "vite-hub/agent/channels"
      const inspect = telegram => telegram()
      const inspectBlock = telegram => { telegram() }
      telegram({ botToken: token })
    `)).toEqual([{ kind: "telegram", keys: ["botToken"] }])
  })

  it("requires imported, unshadowed Agent factories for shorthand discovery", () => {
    expect(uses(`
      const defineAgent = (options) => options
      export default defineAgent({ channels: { telegram: {} } })
    `)).toEqual([])
    expect(uses(`
      import { defineAgent as agent } from "vite-hub/agent"
      import * as agents from "@vite-hub/agent"
      function local(agent) { agent({ channels: { telegram: {} } }) }
      const callback = (agent) => agent({ channels: { telegram: {} } })
      function shadowed() {
        const agents = custom
        agents.defineAgent({ channels: { telegram: {} } })
      }
      agent({ channels: { telegram: {} } })
      agents.defineAgent({ channels: { discord: {} } })
    `)).toEqual([
      { kind: "telegram", keys: [] },
      { kind: "discord", keys: [] },
    ])
  })

  it("keeps calls followed by standalone blocks while ignoring multiline methods", () => {
    expect(uses(`
      import { telegram } from "vite-hub/agent/channels"
      function run() { telegram()
        {} }
      const callback = () => { telegram()
        {} }
      const helpers = { telegram()
        {} }
      class Tools { telegram()
        {} }
      if (config.class) { telegram()
        {} }
      export default { telegram()
        {} }
    `)).toEqual([
      { kind: "telegram", keys: [] },
      { kind: "telegram", keys: [] },
      { kind: "telegram", keys: [] },
    ])
  })

  it.each([
    "telegram?.({ botToken: token })",
    "telegram?.<Runtime>({ botToken: token })",
    "channels.telegram?.({ botToken: token })",
    "channels?.telegram({ botToken: token })",
    "channels?.telegram?.({ botToken: token })",
    "channels?.[\"telegram\"]({ botToken: token })",
    "channels?.[\"telegram\"]?.({ botToken: token })",
    "channels?.[\"telegram\"]<Runtime>({ botToken: token })",
    "channels?.[\"telegram\"]?.<Runtime>({ botToken: token })",
  ])("reads options from optional factory calls: %s", (factory) => {
    expect(uses(`
      import { defineAgent } from "vite-hub/agent"
      import { telegram } from "vite-hub/agent/channels"
      import * as channels from "vite-hub/agent/channels"
      export default defineAgent({ channels: { telegram: ${factory} } })
    `)).toEqual([{ kind: "telegram", keys: ["botToken"] }])
  })

  it("reads parenthesized static options without treating comma expressions as literals", () => {
    expect(uses(`
      import { telegram } from "vite-hub/agent/channels"
      telegram(({}))
      telegram((({ botToken: token })))
      telegram((undefined))
      telegram(({}, options))
      telegram(({} || options))
    `)).toEqual([
      { kind: "telegram", keys: [] },
      { kind: "telegram", keys: ["botToken"] },
      { kind: "telegram", keys: [] },
      { kind: "telegram", keys: undefined },
      { kind: "telegram", keys: undefined },
    ])
  })

  it.each([
    "({} as TelegramChannelOptions)",
    "({} satisfies TelegramChannelOptions)",
    "(({} as Record<string, { value?: string }>))",
    "(({}) satisfies TelegramChannelOptions)",
  ])("preserves required Telegram Env for grouped asserted options: %s", async (options) => {
    expect(uses(`
      import { telegram } from "vite-hub/agent/channels"
      telegram(${options})
    `)).toEqual([{ kind: "telegram", keys: [] }])
    const root = await mkdtemp(join(tmpdir(), "vitehub-channel-env-"))
    try {
      await mkdir(join(root, "server", "agents"), { recursive: true })
      await writeFile(join(root, "server", "agents", "support.ts"), `
        import { defineAgent } from "vite-hub/agent"
        import { telegram } from "vite-hub/agent/channels"
        export default defineAgent({ channels: { telegram: telegram(${options}) } })
      `)
      expect(discoverAgentChannelEnv({ rootDir: root }).telegram?.botToken?.required).toBe(true)
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("preserves explicit credentials in grouped asserted options", () => {
    expect(uses(`
      import { telegram } from "vite-hub/agent/channels"
      telegram(({ botToken: token } as TelegramChannelOptions))
      telegram((({ botToken: token }) satisfies TelegramChannelOptions))
    `)).toEqual([
      { kind: "telegram", keys: ["botToken"] },
      { kind: "telegram", keys: ["botToken"] },
    ])
  })

  it.each([
    "({} as TelegramChannelOptions, options)",
    "({} as TelegramChannelOptions || options)",
    "({} satisfies TelegramChannelOptions && options)",
  ])("keeps grouped asserted runtime expressions unknown: %s", (options) => {
    expect(uses(`
      import { telegram } from "vite-hub/agent/channels"
      telegram(${options})
    `)).toEqual([{ kind: "telegram", keys: undefined }])
  })

  it("marks spread, computed, and variable options as unknown", () => {
    expect(uses(`
      import { telegram } from "vite-hub/agent/channels"
      telegram({ ...shared })
      telegram({ [key]: value })
      telegram(options)
    `)).toEqual([
      { kind: "telegram", keys: undefined },
      { kind: "telegram", keys: undefined },
      { kind: "telegram", keys: undefined },
    ])
  })

  it("finds calls with type arguments", () => {
    expect(uses(`
      import * as channels from "vite-hub/agent/channels"
      import { telegram } from "vite-hub/agent/channels"
      telegram<Runtime>({ botToken: token })
      channels.discord<Map<string, (value: string) => void>>()
    `)).toEqual([
      { kind: "telegram", keys: ["botToken"] },
      { kind: "discord", keys: [] },
    ])
  })

  it("reads shorthands only in the top-level defineAgent() channels option", () => {
    expect(uses(`
      import { defineAgent as agent } from "vite-hub/agent"
      import { telegram } from "vite-hub/agent/channels"
      type Settings = { channels: { telegram: {} } }
      const defaults = { channels: { telegram: {} } }
      export const first = agent<Runtime>({ provider: { channels: { telegram: {} } }, channels: { telegram: { adapter } } })
      export default agent({ "channels": { telegram, discord: {} } })
    `)).toEqual([
      { kind: "telegram", keys: [] },
      { kind: "telegram", keys: [] },
      { kind: "discord", keys: [] },
    ])
  })

  it("classifies bare factories by their kind and follows local objects", () => {
    expect(uses(`
      import { defineAgent } from "vite-hub/agent"
      import { discord, telegram } from "vite-hub/agent/channels"
      const telegramOptions = { botToken: token }
      const channels = { support: telegram, discord: telegram, telegram: telegramOptions }
      export default defineAgent({ channels })
    `)).toEqual([
      { kind: "telegram", keys: [] },
      { kind: "telegram", keys: [] },
      { kind: "telegram", keys: ["botToken"] },
    ])
  })

  it("ignores complete definitions and shadowed factory names", () => {
    expect(uses(`
      import { defineAgent } from "vite-hub/agent"
      import { telegram, discord } from "vite-hub/agent/channels"
      function run(telegram) { return telegram() }
      const wrap = (discord, other) => discord({})
      export default defineAgent({ channels: { telegram: { kind: "custom" } } })
    `)).toEqual([])
  })

  it("distinguishes destructured parameter keys, bindings, types, and defaults", () => {
    expect(uses(`
      import { telegram } from "vite-hub/agent/channels"
      function build({ telegram: configured }: { telegram?: string }) { return telegram() }
      const buildArrow = ({ telegram: configured }: { telegram?: string }) => telegram()
      function typed(configured: telegram) { return telegram() }
      function defaulted(configured = telegram) { return telegram() }
      function shadowed({ factory: telegram }) { return telegram() }
      const shadowedArrow = ({ telegram }) => telegram()
    `)).toEqual(Array.from({ length: 4 }, () => ({ kind: "telegram", keys: [] })))
  })

  it("treats asserted undefined options as omitted", () => {
    expect(uses(`
      import { telegram } from "vite-hub/agent/channels"
      telegram({ botToken: undefined as string | undefined })
      telegram({ botToken: undefined satisfies string | undefined })
      telegram({ botToken: (undefined) })
      telegram({ botToken: undefined! })
      telegram(undefined as TelegramOptions | undefined)
      telegram({ botToken: token as string | undefined })
      telegram({ botToken: undefined as string | undefined ?? token })
    `)).toEqual([
      { kind: "telegram", keys: [] },
      { kind: "telegram", keys: [] },
      { kind: "telegram", keys: [] },
      { kind: "telegram", keys: [] },
      { kind: "telegram", keys: [] },
      { kind: "telegram", keys: ["botToken"] },
      { kind: "telegram", keys: ["botToken"] },
    ])
  })

  it("treats void zero options as omitted without accepting operations on them", () => {
    expect(uses(`
      import { defineAgent } from "vite-hub/agent"
      import { telegram } from "vite-hub/agent/channels"
      telegram({ botToken: void 0, adapter: (void 0) })
      telegram({ botToken: ((void 0)) })
      telegram(void 0)
      telegram((void 0))
      telegram(void(0))
      telegram({ botToken: void((0)) })
      defineAgent({ channels: { telegram: { botToken: void(0) } } })
      defineAgent({ channels: { telegram: { botToken: void 0 } } })
      defineAgent({ channels: { telegram: void 0 } })
      telegram({ botToken: void 0 ?? token })
      telegram({ botToken: (void 0, token) })
    `)).toEqual([
      ...Array.from({ length: 9 }, () => ({ kind: "telegram", keys: [] })),
      { kind: "telegram", keys: ["botToken"] },
      { kind: "telegram", keys: ["botToken"] },
    ])
  })

  it.each(["as TelegramChannelOptions", "satisfies TelegramChannelOptions", "as Options<Runtime>"])("rejects runtime expressions after grouped asserted Channel options with %s", (assertion) => {
    expect(uses(`
      import { telegram } from "vite-hub/agent/channels"
      telegram(({} ${assertion}) || dynamicOptions)
      telegram(({} ${assertion}) && dynamicOptions)
      telegram(({} ${assertion}) ?? dynamicOptions)
    `)).toEqual(Array.from({ length: 3 }, () => ({ kind: "telegram", keys: undefined })))
  })

  it.each(["settings", "(settings)", "settings as AgentOptions", "({ channels: { telegram: {} } })"])("scans locally resolved Agent settings: %s", (settings) => {
    expect(uses(`
      import { defineAgent } from "vite-hub/agent"
      const settings = { channels: { telegram: {} }, driver: customDriver }
      defineAgent(${settings})
    `)).toEqual([{ kind: "telegram", keys: [] }])
  })

  it.each([
    'const unused = {}, channels = { telegram: {} }; defineAgent({ channels })',
    'const unused = call(1, 2), channels = { telegram: {} }, settings = { channels }; defineAgent(settings)',
    'const unused = [1, 2], channels = ({ telegram: {} }); defineAgent({ channels })',
    'const channels: Record<string, { botToken?: string }> = { telegram: {} }; defineAgent({ channels })',
    'const channels: { telegram: { botToken?: string } } = { telegram: {} }; defineAgent({ channels })',
    'const channels:\nRecord<string, { botToken?: string }> = { telegram: {} }; defineAgent({ channels })',
  ])("resolves later const declarators: %s", (source) => {
    expect(uses(`import { defineAgent } from "vite-hub/agent"; ${source}`)).toEqual([{ kind: "telegram", keys: [] }])
  })

  it.each([
    'const settings, actual = { channels: { telegram: {} } };',
    'declare const settings: AgentOptions, actual = { channels: { telegram: {} } };',
    'declare const settings: Record<string, unknown>, actual = { channels: { telegram: {} } };',
    'declare const settings: { channels: unknown }; const actual = { channels: { telegram: {} } };',
    'declare const settings: AgentOptions\nconst actual = { channels: { telegram: {} } };',
  ])("does not borrow another declarator's initializer: %s", (declarations) => {
    expect(uses(`import { defineAgent } from "vite-hub/agent"; ${declarations} defineAgent(settings)`)).toEqual([])
    expect(uses(`import { defineAgent } from "vite-hub/agent"; ${declarations} defineAgent(actual)`)).toEqual([{ kind: "telegram", keys: [] }])
  })

  it("unwraps TypeScript angle assertions on Channel options", () => {
    expect(uses(`
      import { defineAgent } from "vite-hub/agent"
      import { telegram } from "vite-hub/agent/channels"
      telegram(<TelegramOptions>{})
      telegram((<TelegramOptions>{}))
      telegram(<Options<Runtime>><TelegramOptions>{ botToken: token })
      defineAgent({ channels: { telegram: <TelegramOptions>{} } })
    `)).toEqual([
      { kind: "telegram", keys: [] },
      { kind: "telegram", keys: [] },
      { kind: "telegram", keys: ["botToken"] },
      { kind: "telegram", keys: [] },
    ])
  })

  it("keeps calls in labeled and case statement blocks", () => {
    expect(uses(`
      import { telegram } from "vite-hub/agent/channels"
      label: { telegram()
        {} }
      switch (value) { case "ready": { telegram()
        {} } }
      try {} catch { telegram()
        {} }
      class Tools { static { telegram()
        {} } }
      const helpers = { telegram() {} }
      const present = "telegram" in { telegram() {} }
      type Conditional<T> = T extends { telegram(): void } ? true : { telegram(): void }
      const typed: { telegram(): void } = helpers
      function getHelpers(): { telegram(): void } { return helpers }
    `)).toEqual(Array.from({ length: 4 }, () => ({ kind: "telegram", keys: [] })))
  })

  it("unwraps single parenthesized Channels maps", () => {
    expect(uses(`
      import { defineAgent } from "vite-hub/agent"
      const channels: AgentChannelInputs | undefined = { telegram: {} }
      defineAgent({ channels: channels! })
      defineAgent({ channels: (({ telegram: {} })) })
      defineAgent({ channels: ({ telegram: {} }, custom) })
    `)).toEqual([{ kind: "telegram", keys: [] }, { kind: "telegram", keys: [] }])
  })

  it("resolves parenthesized local Channel maps without accepting comma expressions", () => {
    expect(uses(`
      import { defineAgent } from "vite-hub/agent"
      const channels = { telegram: {} }
      defineAgent({ channels: (channels) })
      defineAgent({ channels: ((channels)) })
      defineAgent({ channels: (channels, custom) })
    `)).toEqual([{ kind: "telegram", keys: [] }, { kind: "telegram", keys: [] }])
  })

  it("resolves single parenthesized module-level map initializers", () => {
    expect(uses(`
      import { defineAgent } from "vite-hub/agent"
      const first = ({ telegram: {} })
      const second = (({ telegram: {} } satisfies AgentChannels))
      const third = ({ telegram: {} }) as
        AgentChannels
      const comma = ({ telegram: {} }, custom)
      const operation = ({ telegram: {} } || custom)
      defineAgent({ channels: first })
      defineAgent({ channels: second })
      defineAgent({ channels: third })
      defineAgent({ channels: comma })
      defineAgent({ channels: operation })
    `)).toEqual(Array.from({ length: 3 }, () => ({ kind: "telegram", keys: [] })))
  })

  it.each([
    `({ telegram: {} }) && custom`,
    `(({ telegram: {} })) || custom`,
    `({ telegram: {} }) ? custom : other`,
    `({ telegram: {} })["custom"]`,
    `({ telegram: {} }) as AgentChannels && custom`,
    `({ telegram: {} }) as\nAgentChannels && custom`,
    `{ telegram: {} } && custom`,
    `({ telegram: {} })\n&& custom`,
  ])("rejects operations after module-level map initializers: %s", (expression) => {
    expect(uses(`
      import { defineAgent } from "vite-hub/agent"
      const channels = ${expression}
      defineAgent({ channels })
    `)).toEqual([])
  })

  it("follows typed maps and explicit properties after spreads", () => {
    expect(uses(`
      import { defineAgent } from "vite-hub/agent"
      import { telegram } from "vite-hub/agent/channels"
      const base = {}
      const baseChannels = {}
      const channels: AgentChannels = { ...baseChannels, telegram: {} }
      function format(telegram) { return telegram() }
      export default defineAgent({ ...base, channels })
      export const second = defineAgent({ channels: { ...baseChannels, telegram: {} } })
    `)).toEqual([
      { kind: "telegram", keys: [] },
      { kind: "telegram", keys: [] },
    ])
  })

  it("ignores complete Channel definitions with explicit kinds after spreads", () => {
    expect(uses(`
      import { defineAgent } from "vite-hub/agent"
      const custom = { ...base, kind: "custom" }
      export default defineAgent({ channels: {
        telegram: { ...base, kind: "custom" },
        discord: { kind: "custom", ...base },
        github: custom,
      } })
    `)).toEqual([])
  })

  it("respects local declarations without hiding imported factories outside their scope", () => {
    expect(uses(`
      import { telegram, discord, github } from "vite-hub/agent/channels"
      if (enabled) { const telegram = () => ({}); telegram() }
      function format() { const telegram = () => ({}); return telegram() }
      function mutable() { let discord = () => ({}); return discord() }
      function hoisted() { github(); if (enabled) { var github = () => ({}) } }
      const wrap = () => { const telegram = () => ({}); return telegram() }
      function multiple() { const first = value, telegram = () => ({}); telegram() }
      function destructured() { const { factory: telegram } = local; telegram() }
      for (const telegram of factories) { telegram() }
      const helpers = { format() { var telegram = local; return telegram() } }
      telegram({ botToken: token })
      discord()
      github()
    `)).toEqual([
      { kind: "telegram", keys: ["botToken"] },
      { kind: "discord", keys: [] },
      { kind: "github", keys: [] },
    ])
  })

  it("limits unbraced loop bindings to the loop body", () => {
    expect(uses(`
      import { defineAgent } from "vite-hub/agent"
      import { telegram } from "vite-hub/agent/channels"
      for (const telegram of factories) telegram()
      for (let telegram of factories) telegram();
      for (let telegram = local; ready; next()) telegram();
      for await (const telegram of factories) telegram()
      for (const telegram of factories) telegram(), telegram();
      for (const telegram of factories) if (enabled) telegram(); else telegram();
      for (const telegram of factories) while (enabled) telegram();
      for (const telegram of factories) do telegram(); while (enabled);
      for (const telegram of factories) label: { telegram() }
      for (const telegram of factories) try { telegram() } catch { telegram() }
      defineAgent({ channels: { support: telegram() } })
    `)).toEqual([{ kind: "telegram", keys: [] }])
  })

  it("respects shadowed namespace and bare factory references", () => {
    expect(uses(`
      import { defineAgent } from "vite-hub/agent"
      import { telegram } from "vite-hub/agent/channels"
      import * as channels from "vite-hub/agent/channels"
      function local() {
        const telegram = custom
        const channels = customFactories
        channels.discord()
        return defineAgent({ channels: { bot: telegram } })
      }
      channels.discord()
      export default defineAgent({ channels: { bot: telegram } })
    `)).toEqual([
      { kind: "discord", keys: [] },
      { kind: "telegram", keys: [] },
    ])
  })

  it("treats options set to undefined as omitted", () => {
    expect(uses(`
      import { telegram } from "vite-hub/agent/channels"
      telegram({ botToken: undefined, adapter: undefined, mode: "webhook" })
    `)).toEqual([{ kind: "telegram", keys: ["mode"] }])
  })

  it("treats undefined Channel inputs as empty options", () => {
    expect(uses(`
      import { defineAgent } from "vite-hub/agent"
      import { telegram } from "vite-hub/agent/channels"
      telegram(undefined)
      export default defineAgent({ channels: { telegram: undefined } })
    `)).toEqual([{ kind: "telegram", keys: [] }, { kind: "telegram", keys: [] }])
  })

  it("recognizes async option methods and asserted local maps", () => {
    expect(uses(`
      import { defineAgent } from "vite-hub/agent"
      import { telegram } from "vite-hub/agent/channels"
      const channels = { telegram: { async botToken() { return token } } }
      export const first = defineAgent({ channels: channels satisfies AgentChannelInputs })
      export const second = defineAgent({ channels: channels as AgentChannelInputs })
      telegram({ async botToken() { return token }, get webhookSecret() { return secret } })
    `)).toEqual([
      { kind: "telegram", keys: ["botToken"] },
      { kind: "telegram", keys: ["botToken"] },
      { kind: "telegram", keys: ["botToken", "webhookSecret"] },
    ])
  })

  it.each([
    "<AgentChannelInputs>channels",
    "(<AgentChannelInputs>channels)",
    "<AgentChannelInputs>{ telegram: {} }",
    "(<AgentChannelInputs>{ telegram: {} })",
    "(channels as AgentChannelInputs)",
    "(channels satisfies AgentChannelInputs)",
    "((channels as Record<string, { botToken?: string }>))",
    "(channels! as AgentChannelInputs)",
    "((channels) satisfies AgentChannelInputs)",
  ])("resolves assertions inside parenthesized Channel maps: %s", (expression) => {
    expect(uses(`
      import { defineAgent } from "vite-hub/agent"
      const channels = { telegram: {} }
      export default defineAgent({ channels: ${expression} })
    `)).toEqual([{ kind: "telegram", keys: [] }])
  })

  it.each(["<AgentChannelInputs>{ telegram: {} }", "(<AgentChannelInputs>{ telegram: {} })", "<Record<string, { botToken?: string }>>{ telegram: {} }"])("resolves angle-asserted module Channel maps: %s", (initializer) => {
    expect(uses(`
      import { defineAgent } from "vite-hub/agent"
      const channels = ${initializer};
      export default defineAgent({ channels })
    `)).toEqual([{ kind: "telegram", keys: [] }])
  })

  it.each([
    "(channels as AgentChannelInputs, other)",
    "(channels as AgentChannelInputs || other)",
    "(channels as AgentChannelInputs && other)",
    "(channels as AgentChannelInputs ? other : channels)",
  ])("ignores asserted map expressions with a different runtime value: %s", (expression) => {
    expect(uses(`
      import { defineAgent } from "vite-hub/agent"
      const channels = { telegram: {} }
      export default defineAgent({ channels: ${expression} })
    `)).toEqual([])
  })

  it("distinguishes destructuring keys and defaults from binding names", () => {
    expect(uses(`
      import { telegram } from "vite-hub/agent/channels"
      function computed() { const { [telegram]: value } = source; telegram() }
      function defaultValue() { const { value = fallback || telegram() } = source }
      function nested() { const { nested: { telegram } } = source; telegram() }
      function rest() { const { ...telegram } = source; telegram() }
    `)).toEqual([{ kind: "telegram", keys: [] }, { kind: "telegram", keys: [] }])
  })

  it("keeps imported factories visible after module-level computed destructuring", () => {
    expect(uses(`
      import { telegram } from "vite-hub/agent/channels"
      const { [telegram]: value } = source;
      telegram()
    `)).toEqual([{ kind: "telegram", keys: [] }])
  })

  it("respects function, class, and catch bindings in their lexical scopes", () => {
    expect(uses(`
      import { telegram } from "vite-hub/agent/channels"
      function local() { function telegram() {}; telegram() }
      if (enabled) { class telegram {}; new telegram() }
      try {} catch (telegram) { telegram() }
      const named = function telegram() { return telegram() }
      const namedClass = class telegram { static run() { return new telegram() } }
      telegram()
    `)).toEqual([{ kind: "telegram", keys: [] }])
  })

  it.each([
    "const format = (telegram) => telegram(); telegram()",
    "const format = (telegram) => telegram()\ntelegram()",
    "const callbacks = [(telegram) => telegram(), telegram()]",
    "const format = wrap((telegram) => telegram()); telegram()",
  ])("ends expression-bodied arrow scopes at the expression boundary: %s", (source) => {
    expect(uses(`
      import { telegram } from "vite-hub/agent/channels"
      ${source}
    `)).toEqual([{ kind: "telegram", keys: [] }])
  })

  it("ignores local and unrelated factories", () => {
    expect(uses(`
      import { telegram } from "./channels"
      import type { github } from "vite-hub/agent/channels"
      const slack = () => ({})
      telegram({})
      bot.telegram({})
      // telegram() in a comment
      const label = "telegram()"
    `)).toEqual([])
  })

  it("declares Channel Env for discovered Agents", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-channel-env-"))
    try {
      await mkdir(join(root, "server", "agents"), { recursive: true })
      await writeFile(join(root, "server", "agents", "support.ts"), [
        `import { defineAgent } from "vite-hub/agent"`,
        `import { telegram } from "vite-hub/agent/channels"`,
        `export default defineAgent({ channels: { telegram: telegram(({})) } })`,
      ].join("\n"))
      await writeFile(join(root, "server", "agents", "calories.ts"), [
        `import { defineAgent } from "vite-hub/agent"`,
        `import { telegram } from "vite-hub/agent/channels"`,
        `interface Helpers { telegram(): void }`,
        `const helpers = { telegram() {} }`,
        `class Tools { telegram() {} }`,
        `export default defineAgent({ channels: { telegram: telegram({ botToken: () => "token" }) } })`,
      ].join("\n"))
      await writeFile(join(root, "server", "agents", "unrelated.ts"), [
        `const defineAgent = (options) => options`,
        `export default defineAgent({ channels: { discord: {}, telegram: {} } })`,
      ].join("\n"))

      expect(discoverAgentChannelEnv({ rootDir: root })).toEqual({
        telegram: {
          apiBaseUrl: { names: ["TELEGRAM_API_BASE_URL"], required: false, secret: false },
          botToken: { names: ["TELEGRAM_BOT_TOKEN"], required: true, secret: true },
          webhookSecret: { names: ["TELEGRAM_WEBHOOK_SECRET_TOKEN"], required: false, secret: true },
        },
      })

      await rm(join(root, "server", "agents", "support.ts"))
      expect(discoverAgentChannelEnv({ rootDir: root }).telegram?.botToken?.required).toBe(false)
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it.each(["(telegram)", "((telegram))", "telegram<Runtime>", "channels?.[\"telegram\"]()", "channels?.[\"telegram\"]"])("requires Telegram Env for %s", async (factory) => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-channel-env-"))
    try {
      await mkdir(join(root, "server", "agents"), { recursive: true })
      await writeFile(join(root, "server", "agents", "support.ts"), `
        import { defineAgent } from "vite-hub/agent"
        import { telegram } from "vite-hub/agent/channels"
        import * as channels from "vite-hub/agent/channels"
        export default defineAgent({ channels: { support: ${factory} } })
      `)
      expect(discoverAgentChannelEnv({ rootDir: root }).telegram?.botToken).toEqual({
        names: ["TELEGRAM_BOT_TOKEN"], required: true, secret: true,
      })
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })
})

describe("Telegram adapter Env requirements", () => {
  it.each([
    ['async ["botToken"]() { return token }', false],
    ['async *["botToken"]() { yield token }', false],
    ['get ["botToken"]() { return undefined }', true],
    ['async ["adapter"]() { return customAdapter }', false],
    ['async *["adapter"]() { yield customAdapter }', false],
    ['get ["adapter"]() { return undefined }', true],
  ])("classifies computed option methods: %s", async (property, required) => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-channel-env-"))
    try {
      await mkdir(join(root, "server", "agents"), { recursive: true })
      for (const channel of [`telegram({ ${property} })`, `{ ${property} }`]) {
        await writeFile(join(root, "server", "agents", "support.ts"), `
          import { defineAgent } from "vite-hub/agent"
          import { telegram } from "vite-hub/agent/channels"
          export default defineAgent({ channels: { telegram: ${channel} } })
        `)
        expect(discoverAgentChannelEnv({ rootDir: root }).telegram?.botToken?.required).toBe(required)
      }
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it.each([
    ["adapter() { return customAdapter }", false],
    ["adapter<T>() { return customAdapter }", false],
    ["adapter<T, U>() { return customAdapter }", false],
    ["async adapter<T>() { return customAdapter }", false],
    ["*adapter<T>() { yield customAdapter }", false],
    ["async *adapter<T>() { yield customAdapter }", false],
    ["async adapter() { return customAdapter }", false],
    ["*adapter() { yield customAdapter }", false],
    ["get adapter() { return undefined }", true],
  ])("classifies adapter methods: %s", async (property, required) => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-channel-env-"))
    try {
      await mkdir(join(root, "server", "agents"), { recursive: true })
      for (const channel of [`telegram({ ${property} })`, `{ ${property} }`]) {
        await writeFile(join(root, "server", "agents", "support.ts"), `
          import { defineAgent } from "vite-hub/agent"
          import { telegram } from "vite-hub/agent/channels"
          export default defineAgent({ channels: { telegram: ${channel} } })
        `)
        expect(discoverAgentChannelEnv({ rootDir: root }).telegram?.botToken?.required).toBe(required)
      }
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it.each([
    ["enabled ? customAdapter : undefined", true],
    ["customAdapter", true],
    ["enabled && customAdapter", true],
    ["createAdapter()", true],
    ["({})", false],
    ["{}", false],
    ["() => customAdapter", false],
    ["async () => customAdapter", false],
    ["function () { return customAdapter }", false],
    ["(enabled ? {} : undefined)", true],
    ["({}) && customAdapter", true],
  ])("declares botToken required=%s for adapter %s", async (adapter, required) => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-channel-env-"))
    try {
      await mkdir(join(root, "server", "agents"), { recursive: true })
      await writeFile(join(root, "server", "agents", "support.ts"), `
        import { defineAgent } from "vite-hub/agent"
        import { telegram } from "vite-hub/agent/channels"
        export default defineAgent({ channels: { support: telegram({ adapter: ${adapter} }) } })
      `)
      expect(discoverAgentChannelEnv({ rootDir: root }).telegram?.botToken?.required).toBe(required)
      await writeFile(join(root, "server", "agents", "support.ts"), `
        import { defineAgent } from "vite-hub/agent"
        export default defineAgent({ channels: { telegram: { adapter: ${adapter} } } })
      `)
      expect(discoverAgentChannelEnv({ rootDir: root }).telegram?.botToken?.required).toBe(required)
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })
})

describe("JavaScript Channel Env discovery", () => {
  it.each(["js", "mjs", "cjs"])("does not declare Env for comparisons in %s Agent files", async (extension) => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-channel-env-"))
    try {
      await mkdir(join(root, "server", "agents"), { recursive: true })
      await writeFile(join(root, "server", "agents", `support.${extension}`), `
        import { defineAgent } from "vite-hub/agent"
        import { telegram } from "vite-hub/agent/channels"
        const compared = telegram < Runtime > ({ botToken: token })
        export default defineAgent({ channels: {} })
      `)
      expect(discoverAgentChannelEnv({ rootDir: root })).toEqual({})
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })
})

// Each test imports the Channels module again after resetting mocks.
describe("built-in Channel Env at runtime", { timeout: 30_000 }, () => {
  afterEach(() => {
    vi.doUnmock("#vitehub/env/server")
    vi.doUnmock("@chat-adapter/telegram")
    vi.doUnmock("@chat-adapter/discord")
    vi.resetModules()
  })

  it("reads the canonical VITEHUB_ name before host names without Server Env", async () => {
    const context = { cloudflare: { env: { TELEGRAM_BOT_TOKEN: "vendor-token", VITEHUB_TELEGRAM_BOT_TOKEN: "canonical-token", VITEHUB_GITHUB_TOKEN: "", GH_TOKEN: "gh-token" } } }
    // SAFETY: channelEnvValue reads only `cloudflare.env` from the callback context.
    expect(await channelEnvValue("telegram", "botToken", context as never)).toBe("canonical-token")
    // SAFETY: channelEnvValue reads only `cloudflare.env` from the callback context.
    expect(await channelEnvValue("github", "token", context as never)).toBe("gh-token")
  })

  it.each([
    { code: "ERR_MODULE_NOT_FOUND", message: "Cannot find package 'missing-provider' imported from /app/#vitehub/env/server/generated.mjs", missing: false },
    { code: "ERR_PACKAGE_IMPORT_NOT_DEFINED", message: 'Package import specifier "#missing-provider" is not defined in package /app/#vitehub/env/server/package.json', missing: false },
    { code: "ERR_MODULE_NOT_FOUND", message: "Cannot find package '#vitehub/env/server' imported from /app/agent.mjs", missing: true },
    { code: "ERR_PACKAGE_IMPORT_NOT_DEFINED", message: 'Package import specifier "#vitehub/env/server" is not defined in package /app/package.json', missing: true },
    { code: "ERR_LOAD_URL", message: "Failed to load url #vitehub/env/server (resolved id: #vitehub/env/server) in /app/agent.mjs. Does the file exist?", missing: true },
    { code: "ERR_LOAD_URL", message: "Failed to load url missing-provider (resolved id: missing-provider) in /app/#vitehub/env/server/generated.mjs. Does the file exist?", missing: false },
  ])("falls back only for the missing generated Env specifier: $message", ({ code, message, missing }) => {
    // Native imports preserve loader errors. Vitest wraps errors thrown by mock factories.
    const stdout = execFileSync(process.execPath, ["--input-type=module", "--eval", `
      import { registerHooks } from "node:module"
      registerHooks({ resolve(specifier, context, next) {
        if (specifier === "#vitehub/env/server") throw Object.assign(new Error(${JSON.stringify(message)}), { code: ${JSON.stringify(code)} })
        return next(specifier, context)
      } })
      const { channelEnvValue } = await import(${JSON.stringify(new URL("../src/channel-env.ts", import.meta.url).href)})
      try {
        const value = await channelEnvValue("telegram", "botToken", { cloudflare: { env: { TELEGRAM_BOT_TOKEN: "host-token" } } })
        console.log(JSON.stringify({ value }))
      } catch (error) {
        console.log(JSON.stringify({ code: error.code, message: error.message }))
      }
    `], { encoding: "utf8", timeout: 10_000 })
    expect(JSON.parse(stdout)).toEqual(missing ? { value: "host-token" } : { code, message })
  })

  it("reads Telegram values from Server Env before host names", async () => {
    vi.resetModules()
    const useServerEnv = vi.fn(() => ({ telegram: { botToken: { unseal: () => "server-token" }, webhookSecret: "server-secret" } }))
    vi.doMock("#vitehub/env/server", () => ({ useServerEnv }))
    const createTelegramAdapter = vi.fn(() => ({ name: "telegram" }))
    vi.doMock("@chat-adapter/telegram", () => ({ createTelegramAdapter }))
    const { telegram } = await import("../src/channels.ts")
    const channel = telegram()
    // SAFETY: This test fixture intentionally constructs the exact asserted channel contract.
    const context = { cloudflare: { env: { TELEGRAM_BOT_TOKEN: "host-token" } } } as never

    if (!hasRuntimeType(channel.adapter, "function")) throw new Error("Expected Telegram adapter resolver.")
    await expect(channel.adapter(context)).resolves.toEqual({ name: "telegram" })
    expect(createTelegramAdapter).toHaveBeenCalledWith({ botToken: "server-token", secretToken: "server-secret" })
    expect(useServerEnv).toHaveBeenCalledWith({ env: { TELEGRAM_BOT_TOKEN: "host-token" } })
  })

  it("keeps explicit Telegram options ahead of Server Env", async () => {
    vi.resetModules()
    vi.doMock("#vitehub/env/server", () => ({ useServerEnv: () => ({ telegram: { botToken: "server-token" } }) }))
    const createTelegramAdapter = vi.fn(() => ({ name: "telegram" }))
    vi.doMock("@chat-adapter/telegram", () => ({ createTelegramAdapter }))
    const { telegram } = await import("../src/channels.ts")
    const channel = telegram({ botToken: "option-token", webhookSecret: false })

    if (!hasRuntimeType(channel.adapter, "function")) throw new Error("Expected Telegram adapter resolver.")
    // SAFETY: This test fixture intentionally constructs the exact asserted channel contract.
    await channel.adapter({} as never)
    expect(createTelegramAdapter).toHaveBeenCalledWith({ allowUnverifiedWebhooks: true, botToken: "option-token" })
  })

  it("reads host names only for fields that Server Env does not declare", async () => {
    vi.resetModules()
    vi.doMock("#vitehub/env/server", () => ({ useServerEnv: () => ({ telegram: { webhookSecret: undefined } }) }))
    const createTelegramAdapter = vi.fn(() => ({ name: "telegram" }))
    vi.doMock("@chat-adapter/telegram", () => ({ createTelegramAdapter }))
    const { telegram } = await import("../src/channels.ts")
    const channel = telegram()

    if (!hasRuntimeType(channel.adapter, "function")) throw new Error("Expected Telegram adapter resolver.")
    // SAFETY: This test fixture intentionally constructs the exact asserted channel contract.
    await channel.adapter({ cloudflare: { env: { TELEGRAM_BOT_TOKEN: "host-token", TELEGRAM_WEBHOOK_SECRET_TOKEN: "stale-secret" } } } as never)
    expect(createTelegramAdapter).toHaveBeenCalledWith({ botToken: "host-token" })
  })

  it("keeps Server Env module load errors visible", async () => {
    vi.resetModules()
    vi.doMock("#vitehub/env/server", () => { throw new Error("provider module failed") })
    vi.doMock("@chat-adapter/telegram", () => ({ createTelegramAdapter: vi.fn() }))
    const { telegram } = await import("../src/channels.ts")
    const channel = telegram()

    if (!hasRuntimeType(channel.adapter, "function")) throw new Error("Expected Telegram adapter resolver.")
    // SAFETY: This test fixture intentionally constructs the exact asserted channel contract.
    await expect(channel.adapter({ cloudflare: { env: { TELEGRAM_BOT_TOKEN: "host-token" } } } as never)).rejects.toThrow()
  })

  it("keeps Server Env resolution errors visible", async () => {
    vi.resetModules()
    const missing = new ViteHubError("ENV_REQUIRED_MISSING", "[vitehub] Required Env value is missing.")
    vi.doMock("#vitehub/env/server", () => ({ useServerEnv: () => { throw missing } }))
    vi.doMock("@chat-adapter/telegram", () => ({ createTelegramAdapter: vi.fn() }))
    const { telegram } = await import("../src/channels.ts")
    const channel = telegram()

    if (!hasRuntimeType(channel.adapter, "function")) throw new Error("Expected Telegram adapter resolver.")
    // SAFETY: This test fixture intentionally constructs the exact asserted channel contract.
    await expect(channel.adapter({ cloudflare: { env: { TELEGRAM_BOT_TOKEN: "host-token" } } } as never)).rejects.toBe(missing)
  })

  it("loads provider-backed Channel Env asynchronously", async () => {
    vi.resetModules()
    const group = Object.defineProperty({}, "botToken", {
      enumerable: true,
      get: () => { throw new ViteHubError("ENV_ASYNC_REQUIRED", "[vitehub] Server Env requires asynchronous loading.") },
    })
    const loadServerEnv = vi.fn(async () => ({ telegram: { botToken: "provider-token" } }))
    vi.doMock("#vitehub/env/server", () => ({ loadServerEnv, useServerEnv: () => ({ telegram: group }) }))
    const createTelegramAdapter = vi.fn(() => ({ name: "telegram" }))
    vi.doMock("@chat-adapter/telegram", () => ({ createTelegramAdapter }))
    const { telegram } = await import("../src/channels.ts")
    const channel = telegram({ webhookSecret: false })

    if (!hasRuntimeType(channel.adapter, "function")) throw new Error("Expected Telegram adapter resolver.")
    // SAFETY: This test fixture intentionally constructs the exact asserted channel contract.
    await channel.adapter({} as never)
    expect(createTelegramAdapter).toHaveBeenCalledWith({ allowUnverifiedWebhooks: true, botToken: "provider-token" })
    expect(loadServerEnv).toHaveBeenCalledOnce()
  })

  it("fills Discord adapter credentials from Server Env", async () => {
    vi.resetModules()
    vi.doMock("#vitehub/env/server", () => ({
      useServerEnv: () => ({ discord: { applicationId: "app-id", botToken: { unseal: () => "bot-token" }, publicKey: "public-key" } }),
    }))
    const createDiscordAdapter = vi.fn(() => ({ name: "discord" }))
    vi.doMock("@chat-adapter/discord", () => ({ createDiscordAdapter }))
    const { discord } = await import("../src/channels.ts")
    const channel = discord({ adapter: true })

    if (!hasRuntimeType(channel.adapter, "function")) throw new Error("Expected Discord adapter resolver.")
    // SAFETY: This test fixture intentionally constructs the exact asserted channel contract.
    await expect(channel.adapter({} as never)).resolves.toMatchObject({ name: "discord" })
    expect(createDiscordAdapter).toHaveBeenCalledWith({ applicationId: "app-id", botToken: "bot-token", publicKey: "public-key" })
  })
})

describe("Code Host Server Env discovery", () => {
  it.each([
    ["codeHost()", ["github"]],
    ["codeHost({ host: 'gitlab' })", ["gitlab"]],
    ["codeHost({ host: `gitlab` })", ["gitlab"]],
    ["codeHost({ host: `${selected}` })", ["github", "gitlab", "forgejo"]],
    ["codeHost({ host: 'gitlab', host: selected })", ["github", "gitlab", "forgejo"]],
    ["codeHost({ host: 'forgejo' })", ["forgejo"]],
    ["codeHost({ host: selected })", ["github", "gitlab", "forgejo"]],
    ["codeHost(options)", ["github", "gitlab", "forgejo"]],
    ["codeHost({ host: 'gitlab' + suffix })", ["github", "gitlab", "forgejo"]],
    ["codeHost({ host: 'gitlab', ...options })", ["github", "gitlab", "forgejo"]],
    ["codeHost(({ host: 'gitlab' }))", ["gitlab"]],
  ])("declares optional host fields for %s", async (expression, hosts) => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-code-host-env-"))
    try {
      await mkdir(join(root, "server", "agents"), { recursive: true })
      await writeFile(join(root, "server", "agents", "reviewer.ts"), `
        import { defineAgent } from "vite-hub/agent"
        import { codeHost } from "vite-hub/agent/capabilities"
        export default defineAgent({ capabilities: [${expression}] })
      `)
      const env = discoverAgentChannelEnv({ rootDir: root })
      expect(Object.keys(env)).toEqual(hosts)
      for (const host of hosts) {
        expect(env[host]?.token?.secret).toBe(true)
        expect(Object.values(env[host]!).every(field => !field.required)).toBe(true)
      }
    }
    finally { await rm(root, { recursive: true, force: true }) }
  })

  it.each(["vite-hub/agent/capabilities", "@vite-hub/agent/capabilities"])("reads static strings from aliases and namespaces in %s", (module) => {
    const source = `import { codeHost as host } from '${module}'; import * as caps from '${module}'; host({ host: 'gitlab' }); caps.codeHost({ host: 'forgejo' })`
    const uses = discoverBuiltInChannelUses(source, ["codeHost"], { modules: new Set([module]), shorthands: false })
    expect(uses.map(use => use.stringOptions?.get("host"))).toEqual(["gitlab", "forgejo"])
  })
})

it.each(["gitlab", "forgejo"] as const)("discovers and reads the shared %s Channel Env", async kind => {
  expect(uses(`import { ${kind} } from "vite-hub/agent/channels"; ${kind}({ token: "explicit" })`)).toEqual([{ kind, keys: ["token"] }])
  expect(builtInChannelEnv[kind]).toEqual({
    baseUrl: { names: [`${kind.toUpperCase()}_BASE_URL`] },
    token: { names: [`${kind.toUpperCase()}_TOKEN`], secret: true },
    webhookSecret: { names: [`${kind.toUpperCase()}_WEBHOOK_SECRET`], secret: true },
  })
  const context = { capabilities: {}, memo: vi.fn(), runtime: "unknown" as const, waitUntil: vi.fn(),
    cloudflare: { env: { [`${kind.toUpperCase()}_TOKEN`]: "host-token", [`${kind.toUpperCase()}_BASE_URL`]: "https://host.test" } } }
  expect(await channelEnvValue(kind, "token", context)).toBe("host-token")
  expect(await channelEnvValue(kind, "baseUrl", context)).toBe("https://host.test")
})
