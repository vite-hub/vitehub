import { describe, expect, it, vi } from "vitest"

import type { InputCommand } from "../src/capabilities/input-commands.ts"
import { createMessage, getMessageText } from "../src/messages.ts"

const runtime = () => ({
  capabilities: {},
  memo: vi.fn(),
  runtime: "unknown" as const,
  runtimeConfig: {},
  waitUntil: vi.fn(),
})

describe("inputCommands", () => {
  it.each(["replacement", "result"] as const)("bounds growing command expansion through %s", async (mode) => {
    const { inputCommands } = await import("../src/capabilities.ts")
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    let calls = 0
    const capability = inputCommands({
      commands: {
        loop: {
          call({ text }) {
            if (++calls > 1_500) throw new Error("Expansion did not stop")
            const prompt = `${text} x`
            if (mode === "replacement") return prompt
            return { prompt }
          },
        },
      },
    })

    await expect(resolveAgentCapabilities({ capabilities: [capability] }, runtime(), { prompt: "/loop" }))
      .rejects.toThrow("maximum command expansion depth")
    expect(calls).toBe(1_000)
  })

  it.each(["replacement", "result", "mutation"] as const)("allows a finite expansion through %s", async (mode) => {
    const { inputCommands } = await import("../src/capabilities.ts")
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    let calls = 0
    const capability = inputCommands({
      commands: {
        seed: {
          call({ context }) {
            const prompt = Array.from({ length: 1_001 }, () => "/mark").join(" ")
            if (mode === "replacement") return prompt
            if (mode === "mutation") {
              context.input.set({ prompt })
              return
            }
            return { prompt }
          },
        },
        mark: { call() { calls++ } },
      },
    })

    await resolveAgentCapabilities({ capabilities: [capability] }, runtime(), { prompt: "/seed" })
    expect(calls).toBe(1_001)
  })

  it.each(["replacement", "result", "mutation"] as const)("allows finite equal-size rewrite stages through %s", async (mode) => {
    const { inputCommands } = await import("../src/capabilities.ts")
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    let calls = 0
    const capability = inputCommands({
      commands: {
        a: { call: () => Array.from({ length: 1_000 }, () => "/b").join(" ") },
        b: {
          call({ context }) {
            calls++
            if (mode === "replacement") return "/c"
            const prompt = context.input.get().prompt
            if (typeof prompt !== "string") throw new Error("Expected a string prompt")
            const next = prompt.replace("/b", "/c")
            if (mode === "mutation") {
              context.input.set({ prompt: next })
              return
            }
            return { prompt: next }
          },
        },
        c: { call() { calls++ } },
      },
    })

    const resolved = await resolveAgentCapabilities({ capabilities: [capability] }, runtime(), { prompt: "/a" })
    expect(resolved.input.prompt).toBe("")
    expect(calls).toBe(2_000)
  })

  it.each(["replacement", "result", "mutation"] as const)("allows finite command fan-out through %s", async (mode) => {
    const { inputCommands } = await import("../src/capabilities.ts")
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    let markCalls = 0
    let doneCalls = 0
    const capability = inputCommands({
      commands: {
        seed: { call: () => Array.from({ length: 1_000 }, () => "/mark").join(" ") },
        mark: {
          call({ context }) {
            markCalls++
            if (mode === "replacement") return "/done /done"
            const prompt = context.input.get().prompt
            if (typeof prompt !== "string") throw new Error("Expected a string prompt")
            const next = prompt.replace("/mark", "/done /done")
            if (mode === "mutation") context.input.set({ prompt: next })
            else return { prompt: next }
          },
        },
        done: { call: () => { doneCalls++ } },
      },
    })
    await resolveAgentCapabilities({ capabilities: [capability] }, runtime(), { prompt: "/seed" })
    expect(markCalls).toBe(1_000)
    expect(doneCalls).toBe(2_000)
  })

  it("allows finite void mutations that retain the invoked command", async () => {
    const { inputCommands } = await import("../src/capabilities.ts")
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    let calls = 0
    const capability = inputCommands({
      commands: {
        seed: {
          call({ context }) {
            context.input.set({ prompt: `/seed ${Array.from({ length: 1_001 }, () => "/mark").join(" ")}` })
          },
        },
        mark: { call() { calls++ } },
      },
    })

    const resolved = await resolveAgentCapabilities({ capabilities: [capability] }, runtime(), { prompt: "/seed" })
    expect(resolved.input.prompt).toBe("")
    expect(calls).toBe(1_001)
  })

  it("bounds alternating handlers that introduce more commands", async () => {
    const { inputCommands } = await import("../src/capabilities.ts")
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    let calls = 0
    const expand = (next: string) => () => {
      if (++calls > 1_500) throw new Error("Expansion did not stop")
      return `${next} ${next}`
    }
    const capability = inputCommands({
      commands: {
        first: { call: expand("/second") },
        second: { call: expand("/first") },
      },
    })

    await expect(resolveAgentCapabilities({ capabilities: [capability] }, runtime(), { prompt: "/first" }))
      .rejects.toThrow("maximum command expansion depth")
    expect(calls).toBe(1_004)
  })

  it("bounds alternating equal-size rewrite stages", async () => {
    const { inputCommands } = await import("../src/capabilities.ts")
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    let calls = 0
    const rewrite = (next: string) => () => {
      if (++calls > 1_500) throw new Error("Expansion did not stop")
      return next
    }
    const capability = inputCommands({
      commands: {
        first: { call: rewrite("/second") },
        second: { call: rewrite("/first") },
      },
    })

    await expect(resolveAgentCapabilities({ capabilities: [capability] }, runtime(), { prompt: "/first" }))
      .rejects.toThrow("maximum command expansion depth")
    expect(calls).toBe(1_004)
  })

  it.each(["replacement", "result", "mutation"] as const)("bounds cycles through executable commands with %s", async (mode) => {
    const { inputCommands } = await import("../src/capabilities.ts")
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    let calls = 0
    const rewrite = (next: string): InputCommand["call"] => ({ context, text }) => {
      if (++calls > 1_500) throw new Error("Expansion did not stop")
      const replacement = `/done ${next}`
      if (mode === "replacement") return replacement
      const current = context.input.get().prompt
      if (typeof current !== "string") throw new Error("Expected a string prompt")
      const prompt = current.replace(text, replacement)
      if (mode === "mutation") {
        context.input.set({ prompt })
        return
      }
      return { prompt }
    }
    const capability = inputCommands({
      commands: {
        a: { call: rewrite("/b") },
        b: { call: rewrite("/a") },
        done: { call() {} },
      },
    })

    await expect(resolveAgentCapabilities({ capabilities: [capability] }, runtime(), { prompt: "/a" }))
      .rejects.toThrow("maximum command expansion depth")
    expect(calls).toBeLessThanOrEqual(1_004)
  })

  it.each(["replacement", "result", "mutation"] as const)("scopes cyclic credits to each command lineage through %s", async (mode) => {
    const { inputCommands } = await import("../src/capabilities.ts")
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    let aCalls = 0
    let bCalls = 0
    const capability = inputCommands({
      commands: {
        a: {
          call({ context, text }) {
            aCalls++
            const replacement = ""
            if (mode === "replacement") return replacement
            const prompt = context.input.get().prompt
            if (typeof prompt !== "string") throw new Error("Expected a string prompt")
            const rewritten = prompt.replace(text, replacement)
            if (mode === "mutation") context.input.set({ prompt: rewritten })
            else return { prompt: rewritten }
          },
        },
        b: {
          call({ context, text }) {
            bCalls++
            const replacement = bCalls === 1 ? "" : Array.from({ length: 1_001 }, () => "/a").join(" ")
            if (mode === "replacement") return replacement
            const prompt = context.input.get().prompt
            if (typeof prompt !== "string") throw new Error("Expected a string prompt")
            const rewritten = prompt.replace(text, replacement)
            if (mode === "mutation") context.input.set({ prompt: rewritten })
            else return { prompt: rewritten }
          },
        },
      },
    })

    await resolveAgentCapabilities({ capabilities: [capability] }, runtime(), { prompt: "/a /b /b" })
    expect(aCalls).toBe(1_002)
    expect(bCalls).toBe(2)
  })

  it.each(["replacement", "result", "mutation"] as const)("clears cyclic credits after a completed lineage through %s", async (mode) => {
    const { inputCommands } = await import("../src/capabilities.ts")
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    let aCalls = 0
    let bCalls = 0
    const capability = inputCommands({
      commands: {
        a: {
          call({ context, text }) {
            aCalls++
            const replacement = aCalls === 1 ? "/b" : aCalls === 2 ? "" : Array.from({ length: 1_004 }, () => "/b").join(" ")
            if (mode === "replacement") return replacement
            const prompt = context.input.get().prompt
            if (typeof prompt !== "string") throw new Error("Expected a string prompt")
            const rewritten = prompt.replace(text, replacement)
            if (mode === "mutation") context.input.set({ prompt: rewritten })
            else return { prompt: rewritten }
          },
        },
        b: {
          call({ context, text }) {
            bCalls++
            const replacement = bCalls === 1 ? "/a" : ""
            if (mode === "replacement") return replacement
            const prompt = context.input.get().prompt
            if (typeof prompt !== "string") throw new Error("Expected a string prompt")
            const rewritten = prompt.replace(text, replacement)
            if (mode === "mutation") context.input.set({ prompt: rewritten })
            else return { prompt: rewritten }
          },
        },
      },
    })

    await resolveAgentCapabilities({ capabilities: [capability] }, runtime(), { prompt: "/a /a" })
    expect(aCalls).toBe(3)
    expect(bCalls).toBe(1_005)
  })

  it("does not renew a recursive cycle when removing a sibling", async () => {
    const { inputCommands } = await import("../src/capabilities.ts")
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    let calls = 0
    const capability = inputCommands({
      commands: {
        a: { call: () => { calls++; return "/b /remove" } },
        b: { call: () => "/a" },
        remove: { call() {} },
      },
    })

    await expect(resolveAgentCapabilities({ capabilities: [capability] }, runtime(), { prompt: "/a /remove" }))
      .rejects.toThrow("maximum command expansion depth")
    expect(calls).toBeLessThan(1_500)
  })

  it("bounds cycles longer than two commands that introduce more commands", async () => {
    const { inputCommands } = await import("../src/capabilities.ts")
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    let calls = 0
    const expand = (next: string) => () => {
      if (++calls > 1_500) throw new Error("Expansion did not stop")
      return `${next} ${next}`
    }
    const capability = inputCommands({
      commands: {
        first: { call: expand("/second") },
        second: { call: expand("/third") },
        third: { call: expand("/first") },
      },
    })

    await expect(resolveAgentCapabilities({ capabilities: [capability] }, runtime(), { prompt: "/first" }))
      .rejects.toThrow("maximum command expansion depth")
    expect(calls).toBeLessThan(1_500)
  })

  it.each(["replacement", "result", "mutation"] as const)("bounds recursive stages after leading text through %s", async (mode) => {
    const { inputCommands } = await import("../src/capabilities.ts")
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    let calls = 0
    const rewrite = (next: string): InputCommand["call"] => ({ context }) => {
      if (++calls > 1_500) throw new Error("Expansion did not stop")
      if (mode === "replacement") return `x ${next}`
      const prompt = context.input.get().prompt
      if (typeof prompt !== "string") throw new Error("Expected a string prompt")
      const rewritten = prompt.replace(/\/(first|second)/, `x ${next}`)
      if (mode === "mutation") context.input.set({ prompt: rewritten })
      else return { prompt: rewritten }
    }
    const capability = inputCommands({
      commands: {
        first: { call: rewrite("/second") },
        second: { call: rewrite("/first") },
      },
    })

    await expect(resolveAgentCapabilities({ capabilities: [capability] }, runtime(), { prompt: "/first" }))
      .rejects.toThrow("maximum command expansion depth")
    expect(calls).toBeLessThan(1_500)
  })

  it.each(["replacement", "result", "mutation"] as const)("bounds recursive stages after channel-skipped commands through %s", async (mode) => {
    const { inputCommands } = await import("../src/capabilities.ts")
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    let calls = 0
    const rewrite = (next: string): InputCommand["call"] => ({ context }) => {
      if (++calls > 1_500) throw new Error("Expansion did not stop")
      if (mode === "replacement") return next
      const prompt = `/skip ${next}`
      if (mode === "mutation") context.input.set({ prompt })
      else return { prompt }
    }
    const capability = inputCommands({
      commands: {
        skip: { channels: ["other"], call() { throw new Error("Skipped command ran") } },
        a: { call: rewrite("/b") },
        b: { call: rewrite("/a") },
      },
    })

    await expect(resolveAgentCapabilities({ capabilities: [capability] }, runtime(), { prompt: "/skip /a" }))
      .rejects.toThrow("maximum command expansion depth")
    expect(calls).toBeLessThan(1_500)
  })

  it.each(["replacement", "result", "mutation"] as const)("bounds mixed same-command recursive expansion through %s", async (mode) => {
    const { inputCommands } = await import("../src/capabilities.ts")
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    let calls = 0
    const capability = inputCommands({
      commands: {
        same: {
          call({ args, context, text }) {
            if (++calls > 1_500) throw new Error("Expansion did not stop")
            const replacement = Number(args) > 0 ? "/same 0 /same 1" : ""
            if (mode === "replacement") return replacement
            const prompt = context.input.get().prompt
            if (typeof prompt !== "string") throw new Error("Expected a string prompt")
            const rewritten = prompt.replace(text, replacement)
            if (mode === "mutation") context.input.set({ prompt: rewritten })
            else return { prompt: rewritten }
          },
        },
      },
    })

    await expect(resolveAgentCapabilities({ capabilities: [capability] }, runtime(), { prompt: "/same 1" }))
      .rejects.toThrow("maximum command expansion depth")
    expect(calls).toBeLessThan(1_500)
  })

  it.each(["result", "mutation"] as const)("bounds cycles revealed at a rewrite boundary through %s", async (mode) => {
    const { inputCommands } = await import("../src/capabilities.ts")
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    let calls = 0
    const rewrite = (prompt: string): InputCommand["call"] => ({ context }) => {
      if (++calls > 1_500) throw new Error("Expansion did not stop")
      if (mode === "mutation") context.input.set({ prompt })
      else return { prompt }
    }
    const capability = inputCommands({
      commands: {
        a: { call: rewrite(" /_  /b y/a") },
        b: { call: rewrite(" /_ x/b  /a") },
      },
    })

    await expect(resolveAgentCapabilities({ capabilities: [capability] }, runtime(), { prompt: " /_  /b y/a" }))
      .rejects.toThrow("maximum command expansion depth")
    expect(calls).toBeLessThan(1_500)
  })

  it.each(["2001", "9".repeat(400), "9007199254740991", "9007199254740992"])("bounds cycles with an unsafe numeric argument %s", async (depth) => {
    const { inputCommands } = await import("../src/capabilities.ts")
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    let calls = 0
    const rewrite = (next: string) => () => {
      if (++calls > 1_500) throw new Error("Expansion did not stop")
      return { prompt: `/${next} ${depth}` }
    }
    const capability = inputCommands({
      commands: {
        a: { call: rewrite("b") },
        b: { call: rewrite("a") },
      },
    })

    await expect(resolveAgentCapabilities({ capabilities: [capability] }, runtime(), { prompt: `/a ${depth}` }))
      .rejects.toThrow("maximum command expansion depth")
    expect(calls).toBeLessThan(1_500)
  })

  it("allows a bounded decreasing numeric cycle", async () => {
    const { inputCommands } = await import("../src/capabilities.ts")
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    let calls = 0
    const rewrite = (next: string): InputCommand["call"] => ({ args }) => {
      calls++
      const depth = Number(args.split(" ")[0])
      return depth > 0 ? { prompt: `/${next} ${depth - 1}` } : undefined
    }
    const capability = inputCommands({
      commands: {
        a: { call: rewrite("b") },
        b: { call: rewrite("a") },
      },
    })

    await resolveAgentCapabilities({ capabilities: [capability] }, runtime(), { prompt: "/a 2001" })
    expect(calls).toBe(2002)
  })

  it("bounds numeric cycles that restore their depth", async () => {
    const { inputCommands } = await import("../src/capabilities.ts")
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    let calls = 0
    const capability = inputCommands({
      commands: {
        a: { call: ({ args }) => {
          calls++
          return { prompt: `/b ${Number(args) - 1}` }
        } },
        b: { call: ({ args }) => {
          calls++
          return { prompt: `/a ${Number(args) + 1}` }
        } },
      },
    })

    await expect(resolveAgentCapabilities({ capabilities: [capability] }, runtime(), { prompt: "/a 1" }))
      .rejects.toThrow("maximum command expansion depth")
    expect(calls).toBeLessThan(1_500)
  })

  it("bounds positive-depth numeric oscillation cycles", async () => {
    const { inputCommands } = await import("../src/capabilities.ts")
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    let calls = 0
    const capability = inputCommands({
      commands: {
        a: { call: ({ args }) => {
          calls++
          return { prompt: `/b ${Number(args) - 1}` }
        } },
        b: { call: ({ args }) => {
          calls++
          return { prompt: `/a ${Number(args) + 1}` }
        } },
      },
    })

    await expect(resolveAgentCapabilities({ capabilities: [capability] }, runtime(), { prompt: "/a 2" }))
      .rejects.toThrow("maximum command expansion depth")
    expect(calls).toBeLessThan(1_500)
  })

  it("resets numeric transition depth tracking between independent branches", async () => {
    const { inputCommands } = await import("../src/capabilities.ts")
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    let leaves = 0
    const capability = inputCommands({
      commands: {
        root: { call: () => "/a 1 /a 2" },
        a: { call: ({ args }) => `/b ${Number(args) - 1}` },
        b: { call: () => Array.from({ length: 1_001 }, () => "/leaf").join(" ") },
        leaf: { call: () => { leaves++ } },
      },
    })

    await resolveAgentCapabilities({ capabilities: [capability] }, runtime(), { prompt: "/root" })
    expect(leaves).toBe(2_002)
  })

  it.each(["replacement", "result", "mutation"] as const)("allows decreasing same-command fan-out with options through %s", async (mode) => {
    const { inputCommands } = await import("../src/capabilities.ts")
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    let calls = 0
    const capability = inputCommands({
      commands: {
        same: {
          call({ args, context, text }) {
            calls++
            const depth = Number(args.split(" ")[0])
            const replacement = depth > 0 ? `/same ${depth - 1} --format brief /same ${depth - 1} --format brief` : ""
            if (mode === "replacement") return replacement
            const prompt = context.input.get().prompt
            if (typeof prompt !== "string") throw new Error("Expected a string prompt")
            const rewritten = prompt.replace(text, replacement)
            if (mode === "mutation") context.input.set({ prompt: rewritten })
            else return { prompt: rewritten }
          },
        },
      },
    })

    await resolveAgentCapabilities({ capabilities: [capability] }, runtime(), { prompt: "/same 9 --format brief" })
    expect(calls).toBe(1_023)
  })

  it("allows finite decreasing binary fan-out through zero-depth leaves", async () => {
    const { inputCommands } = await import("../src/capabilities.ts")
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    let calls = 0
    const capability = inputCommands({
      commands: {
        a: {
          call({ args }) {
            calls++
            const depth = Number(args)
            return depth > 0 ? `/a ${depth - 1} /a ${depth - 1}` : ""
          },
        },
      },
    })

    await resolveAgentCapabilities({ capabilities: [capability] }, runtime(), { prompt: "/a 11" })
    expect(calls).toBe(4_095)
  })

  // This regression executes the full million-command budget. It takes seconds
  // when each step stays small, so the timeout also catches quadratic growth.
  it("caps cumulative work for numeric fan-out", async () => {
    const { inputCommands } = await import("../src/capabilities.ts")
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    let calls = 0
    const capability = inputCommands({
      commands: {
        same: {
          call({ args }) {
            calls++
            const depth = Number(args)
            return depth > 0 ? `/same ${depth - 1} /same ${depth - 1}` : ""
          },
        },
      },
    })

    await expect(resolveAgentCapabilities({ capabilities: [capability] }, runtime(), { prompt: "/same 21" }))
      .rejects.toThrow("maximum command expansion depth")
    expect(calls).toBeLessThanOrEqual(1_000_001)
  }, 60_000)

  it("allows finite same-command fan-out", async () => {
    const { inputCommands } = await import("../src/capabilities.ts")
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    let calls = 0
    const capability = inputCommands({
      commands: {
        same: {
          call({ args }) {
            calls++
            const depth = Number(args)
            return depth > 0 ? `/same ${depth - 1} /same ${depth - 1}` : ""
          },
        },
      },
    })

    await resolveAgentCapabilities({ capabilities: [capability] }, runtime(), { prompt: "/same 9" })
    expect(calls).toBe(1_023)
  })

  it.each(["replacement", "result", "mutation"] as const)("does not treat untouched sibling commands as a recursive cycle through %s", async (mode) => {
    const { inputCommands } = await import("../src/capabilities.ts")
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    let marks = 0
    let aCalls = 0
    const rewrite = (replacement: () => string): InputCommand["call"] => ({ context, text }) => {
      const value = replacement()
      if (mode === "replacement") return value
      const prompt = context.input.get().prompt
      if (typeof prompt !== "string") throw new Error("Expected a string prompt")
      const rewritten = prompt.replace(text, value)
      if (mode === "mutation") context.input.set({ prompt: rewritten })
      else return { prompt: rewritten }
    }
    const capability = inputCommands({
      commands: {
        a: { call: rewrite(() => ++aCalls === 1 ? "text" : Array.from({ length: 1_001 }, () => "/mark").join(" ")) },
        b: { call: rewrite(() => "text") },
        mark: { call: () => { marks++ } },
      },
    })

    const resolved = await resolveAgentCapabilities({ capabilities: [capability] }, runtime(), { prompt: "/a /b /a" })
    expect(resolved.input.prompt).toBe("text text")
    expect(marks).toBe(1_001)
  })

  it.each(["replacement", "result", "mutation"] as const)("allows delayed finite expansion by the same command through %s", async (mode) => {
    const { inputCommands } = await import("../src/capabilities.ts")
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    let calls = 0
    const capability = inputCommands({
      commands: {
        same: {
          call({ context }) {
            calls++
            if (calls > 1_000) return
            const prompt = calls === 1_000 ? "/same /same" : `/same ${calls}`
            if (mode === "replacement") return prompt
            if (mode === "mutation") {
              context.input.set({ prompt })
              return
            }
            return { prompt }
          },
        },
      },
    })

    const resolved = await resolveAgentCapabilities({ capabilities: [capability] }, runtime(), { prompt: "/same start" })
    expect(resolved.input.prompt).toBe("")
    expect(calls).toBe(1_002)
  })

  it("leaves inherited command names as ordinary input", async () => {
    const { inputCommands } = await import("../src/capabilities.ts")
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")

    const resolved = await resolveAgentCapabilities({
      capabilities: [inputCommands({ commands: {} })],
    }, runtime(), { prompt: "/constructor" })

    expect(resolved.input.prompt).toBe("/constructor")
  })

  it("accepts an explicitly registered constructor command", async () => {
    const { inputCommands } = await import("../src/capabilities.ts")
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")

    const resolved = await resolveAgentCapabilities({
      capabilities: [inputCommands({ commands: { constructor: { call: () => "Registered command" } } })],
    }, runtime(), { prompt: "/constructor" })

    expect(resolved.input.prompt).toBe("Registered command")
  })

  it("exposes resolved runtime primitives and can reply without running the driver", async () => {
    const { agentInvocationId } = await import("../src/invocations.ts")
    const { inputCommands } = await import("../src/capabilities.ts")
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    const diagnosticsRuntime = { invocations: { db: "db", schema: "schema" } }
    const runId = "debug-command-run"

    const resolved = await resolveAgentCapabilities({
      capabilities: [inputCommands({
        commands: {
          debug: {
            async call({ context }) {
              // SAFETY: This test registers diagnostics in the runtime Capability map below.
              expect((context as typeof context & { diagnostics: typeof diagnosticsRuntime }).diagnostics).toBe(diagnosticsRuntime)
              expect(context.invocation.id).toBe(await agentInvocationId(runId, "support"))
              return context.reply("https://chat.example/_vitehub/invocations/previous")
            },
          },
        },
      })],
    }, {
      ...runtime(),
      agentIdentity: { name: "support" },
      capabilities: {
        diagnostics: { resolve: () => diagnosticsRuntime },
      },
      run: { runId },
    }, { prompt: "/debug" })

    expect(resolved.response?.status).toBe(204)
    expect(resolved.registries.deliveryEffectIntents).toEqual([
      { kind: "reply", payload: "https://chat.example/_vitehub/invocations/previous" },
    ])
  })

  it("replaces command text in a string prompt", async () => {
    const { inputCommands } = await import("../src/capabilities.ts")
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")

    const resolved = await resolveAgentCapabilities({
      capabilities: [inputCommands({
        commands: {
          review: {
            description: "Review the request.",
            call: ({ args }) => `Review this: ${args}`,
          },
        },
      })],
    }, runtime(), { prompt: "/review auth changes" })

    expect(resolved.input.prompt).toBe("Review this: auth changes")
  })

  it("keeps command-only text when a string handler returns empty args", async () => {
    const { inputCommands } = await import("../src/capabilities.ts")
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")

    const resolved = await resolveAgentCapabilities({
      capabilities: [inputCommands({
        commands: {
          summary: {
            description: "Summarize the request.",
            call: ({ args }) => args,
          },
        },
      })],
    }, runtime(), { prompt: "/summary" })

    expect(resolved.input.prompt).toBe("/summary")
  })

  it("removes accepted command text when no handler is configured", async () => {
    const { inputCommands } = await import("../src/capabilities.ts")
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")

    const resolved = await resolveAgentCapabilities({
      capabilities: [inputCommands({
        commands: {
          review: {
          },
        },
      })],
    }, runtime(), { prompt: "/review auth changes" })

    expect(resolved.input.prompt).toBe("")
  })

  it("removes command-only text when no handler is configured", async () => {
    const { inputCommands } = await import("../src/capabilities.ts")
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")

    const resolved = await resolveAgentCapabilities({
      capabilities: [inputCommands({
        commands: {
          summary: {
            description: "Summarize the request.",
          },
        },
      })],
    }, runtime(), { prompt: "/summary" })

    expect(resolved.input.prompt).toBe("")
  })

  it("removes command-only text without using command names", async () => {
    const { inputCommands } = await import("../src/capabilities.ts")
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")

    const resolved = await resolveAgentCapabilities({
      capabilities: [inputCommands({
        commands: {
          summary: {},
        },
      })],
    }, runtime(), { prompt: "/summary" })

    expect(resolved.input.prompt).toBe("")
  })

  it("accepts hook-only commands and removes bare command text", async () => {
    const { inputCommands } = await import("../src/capabilities.ts")
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    const hook = vi.fn()

    const resolved = await resolveAgentCapabilities({
      capabilities: [inputCommands({
        commands: {
          summary: {
            hooks: {
              "agent:input": hook,
            },
          },
        },
      })],
    }, runtime(), { prompt: "/summary" })

    expect(resolved.input.prompt).toBe("")
    expect(hook).toHaveBeenCalledWith(expect.objectContaining({
      name: "summary",
      text: "/summary",
    }))
  })

  it("keeps command-only message text when a string handler returns empty args", async () => {
    const { inputCommands } = await import("../src/capabilities.ts")
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")

    const resolved = await resolveAgentCapabilities({
      capabilities: [inputCommands({
        commands: {
          review: {
            description: "Review the request.",
            call: ({ args }) => args,
          },
        },
      })],
    }, runtime(), { messages: [createMessage({ role: "user", text: "/review" })] })

    expect(resolved.input.messages?.map(message => getMessageText(message))).toEqual(["/review"])
  })

  it.each([
    ["/drop\n/fill", "second"],
    ["first\n/drop\n/fill", "first\nsecond"],
    ["first /drop", "first"],
    ["first /drop   ", "first"],
    ["first /drop /drop /fill", "first second"],
  ])("removes one separator with an empty string replacement in %j", async (prompt, expected) => {
    const { inputCommands } = await import("../src/capabilities.ts")
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    const capability = inputCommands({ commands: { drop: { call: () => "" }, fill: { call: () => "second" } } })

    const resolved = await resolveAgentCapabilities({ capabilities: [capability] }, runtime(), { prompt })
    expect(resolved.input.prompt).toBe(expected)

    const fromMessage = await resolveAgentCapabilities({ capabilities: [capability] }, runtime(), {
      messages: [createMessage({ role: "user", text: prompt })],
    })
    expect(fromMessage.input.messages?.map(message => getMessageText(message))).toEqual([expected])
  })

  it("keeps the text size bounded while empty replacements remove fan-out leaves", async () => {
    const { inputCommands } = await import("../src/capabilities.ts")
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    let longest = 0
    const capability = inputCommands({
      commands: {
        same: {
          call({ args, context }) {
            longest = Math.max(longest, String(context.input.get().prompt).length)
            const depth = Number(args)
            return depth > 0 ? `/same ${depth - 1} /same ${depth - 1}` : ""
          },
        },
      },
    })

    // Each removed leaf used to leave its separator, so 4,095 calls grew the
    // prompt to about 2,000 characters and made every later step slower.
    const resolved = await resolveAgentCapabilities({ capabilities: [capability] }, runtime(), { prompt: "/same 11" })
    expect(resolved.input.prompt).toBe("/same 0")
    expect(longest).toBeLessThanOrEqual(100)
  })

  it("replaces command text from an initial message", async () => {
    const { inputCommands } = await import("../src/capabilities.ts")
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")

    const resolved = await resolveAgentCapabilities({
      capabilities: [inputCommands({
        commands: {
          review: {
            description: "Review the request.",
            call: ({ args }) => `Review this: ${args}`,
          },
        },
      })],
    }, runtime(), { message: "/review auth changes" })

    expect(resolved.input.messages?.map(message => getMessageText(message))).toEqual(["Review this: auth changes"])
    expect(resolved.input.message).toBeUndefined()
  })

  it("replaces command text in the latest user message", async () => {
    const { inputCommands } = await import("../src/capabilities.ts")
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")

    const assistant = createMessage({ role: "assistant", text: "ok" })
    const first = createMessage({ role: "user", text: "/review old" })
    const latest = createMessage({ id: "latest", role: "user", text: "Please /review auth" })
    const resolved = await resolveAgentCapabilities({
      capabilities: [inputCommands({
        commands: {
          review: {
            description: "Review the request.",
            call: ({ args }) => `review:${args}`,
          },
        },
      })],
    }, runtime(), { messages: [first, assistant, latest] })

    expect(resolved.input.messages?.map(message => getMessageText(message))).toEqual([
      "/review old",
      "ok",
      "Please review:auth",
    ])
    expect(resolved.input.messages?.[2]?.id).toBe("latest")
  })

  it("clears stale string prompts after latest user message replacement", async () => {
    const { inputCommands } = await import("../src/capabilities.ts")
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")

    const resolved = await resolveAgentCapabilities({
      capabilities: [inputCommands({
        commands: {
          review: {
            description: "Review the request.",
            call: ({ args }) => `review:${args}`,
          },
        },
      })],
    }, runtime(), {
      messages: [createMessage({ role: "user", text: "/review auth" })],
      prompt: "stale prompt",
    })

    expect(getMessageText(resolved.input.messages![0]!)).toBe("review:auth")
    expect(resolved.input.prompt).toBeUndefined()
  })

  it("falls back to a string prompt when messages have no user message", async () => {
    const { inputCommands } = await import("../src/capabilities.ts")
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")

    const resolved = await resolveAgentCapabilities({
      capabilities: [inputCommands({
        commands: {
          review: {
            description: "Review the request.",
            call: ({ args }) => `review:${args}`,
          },
        },
      })],
    }, runtime(), {
      messages: [],
      prompt: "/review auth",
    })

    expect(resolved.input.prompt).toBe("review:auth")
    expect(resolved.input.messages).toEqual([])
  })

  it("preserves non-text message parts when replacing message text", async () => {
    const { inputCommands } = await import("../src/capabilities.ts")
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")

    const message = createMessage({
      id: "structured",
      parts: [
        { id: "data-1", data: { source: "ui" }, type: "data" },
        { id: "text-a", text: "Please /review auth", type: "text" },
        { id: "source-1", title: "Auth file", type: "source", url: "file://auth.ts" },
      ],
      role: "user",
    })

    const resolved = await resolveAgentCapabilities({
      capabilities: [inputCommands({
        commands: {
          review: {
            description: "Review the request.",
            call: ({ args }) => `review:${args}`,
          },
        },
      })],
    }, runtime(), { messages: [message] })

    expect(resolved.input.messages?.[0]?.parts).toEqual([
      { id: "data-1", data: { source: "ui" }, type: "data" },
      { id: "text-a", text: "Please review:auth", type: "text" },
      { id: "source-1", title: "Auth file", type: "source", url: "file://auth.ts" },
    ])
  })

  it("preserves text part ordering around non-text parts when replacing message text", async () => {
    const { inputCommands } = await import("../src/capabilities.ts")
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")

    const message = createMessage({
      id: "interleaved",
      parts: [
        { id: "text-a", text: "prefix ", type: "text" },
        { id: "data-1", data: { source: "ui" }, type: "data" },
        { id: "text-b", text: "/review auth", type: "text" },
      ],
      role: "user",
    })

    const resolved = await resolveAgentCapabilities({
      capabilities: [inputCommands({
        commands: {
          review: {
            description: "Review the request.",
            call: ({ args }) => `review:${args}`,
          },
        },
      })],
    }, runtime(), { messages: [message] })

    expect(resolved.input.messages?.[0]?.parts).toEqual([
      { id: "text-a", text: "prefix ", type: "text" },
      { id: "data-1", data: { source: "ui" }, type: "data" },
      { id: "text-b", text: "review:auth", type: "text" },
    ])
  })

  it("merges partial run input while preserving existing context keys", async () => {
    const { inputCommands } = await import("../src/capabilities.ts")
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")

    const resolved = await resolveAgentCapabilities({
      capabilities: [inputCommands({
        commands: {
          issue: {
            description: "Attach issue context.",
            call: ({ args }) => ({
              context: { issue: args, keep: "override" },
              options: { mode: "focused" },
              timeout: 100,
            }),
          },
        },
      })],
    }, runtime(), {
      context: { keep: "base", untouched: true },
      prompt: "/issue VH-123",
    })

    expect(resolved.input).toMatchObject({
      context: { issue: "VH-123", keep: "override", untouched: true },
      options: { mode: "focused" },
      prompt: "",
      timeout: 100,
    })
  })

  it("accepts commands without adding prompt text", async () => {
    const { inputCommands } = await import("../src/capabilities.ts")
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")

    const resolved = await resolveAgentCapabilities({
      capabilities: [inputCommands({
        commands: {
          review: {
            description: "Review the request.",
            call: ({ args }) => ({ context: { review: { args } } }),
          },
        },
      })],
    }, runtime(), { prompt: "/review auth changes" })

    expect(resolved.input.context).toEqual({ review: { args: "auth changes" } })
    expect(resolved.input.prompt).toBe("")
  })

  it("registers finish hooks when a command returns a handled response", async () => {
    const { inputCommands } = await import("../src/capabilities.ts")
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")

    const resolved = await resolveAgentCapabilities({
      capabilities: [inputCommands({
        commands: {
          block: {
            description: "Block the request.",
            call: () => Response.json({ accepted: false }),
            hooks: {
              async "agent:finish"(context) {
                await context.message.reply(`handled:${context.text}`)
              },
            },
          },
        },
      })],
    }, runtime(), { prompt: "/block now" })
    const finishProvider = resolved.registries.finishDeliveryEffectProviders[0] as (event: unknown, context: unknown) => unknown

    expect(resolved.response).toBeInstanceOf(Response)
    expect(typeof finishProvider).toBe("function")
    await expect(finishProvider({ result: resolved.response } as never, {} as never)).resolves.toEqual([
      { kind: "reply", payload: "handled:/block now" },
    ])
  })

  it("treats returned messages as authoritative over a stale string prompt", async () => {
    const { inputCommands } = await import("../src/capabilities.ts")
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    const message = createMessage({ role: "user", text: "rewritten" })

    const resolved = await resolveAgentCapabilities({
      capabilities: [inputCommands({
        commands: {
          switch: {
            description: "Switch to messages.",
            call: () => ({ messages: [message] }),
          },
        },
      })],
    }, runtime(), { prompt: "/switch now" })

    expect(resolved.input.messages).toEqual([message])
    expect(resolved.input.prompt).toBeUndefined()
  })

  it("treats returned prompt as authoritative over stale messages", async () => {
    const { inputCommands } = await import("../src/capabilities.ts")
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")

    const resolved = await resolveAgentCapabilities({
      capabilities: [inputCommands({
        commands: {
          switch: {
            description: "Switch to a prompt.",
            call: () => ({ prompt: "rewritten" }),
          },
        },
      })],
    }, runtime(), { messages: [createMessage({ role: "user", text: "/switch now" })] })

    expect(resolved.input.prompt).toBe("rewritten")
    expect(resolved.input.messages).toBeUndefined()
  })

  it("supports custom ids and rejects duplicate default ids through capability validation", async () => {
    const { inputCommands } = await import("../src/capabilities.ts")
    const { normalizeCapabilities, resolveAgentCapabilities } = await import("../src/capability-runtime.ts")

    expect(() => normalizeCapabilities([
      inputCommands({ commands: { one: { description: "One.", call: () => undefined } } }),
      inputCommands({ commands: { two: { description: "Two.", call: () => undefined } } }),
    ])).toThrow("Duplicate capability id")

    const resolved = await resolveAgentCapabilities({
      capabilities: [
        inputCommands({
          commands: { one: { description: "One.", call: () => "one" } },
        }),
        inputCommands({
          id: "bangCommands",
          trigger: "!",
          commands: { two: { description: "Two.", call: () => "two" } },
        }),
      ],
    }, runtime(), { prompt: "!two" })

    expect(resolved.input.prompt).toBe("two")
  })

  it("uses a custom trigger", async () => {
    const { inputCommands } = await import("../src/capabilities.ts")
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")

    const resolved = await resolveAgentCapabilities({
      capabilities: [inputCommands({
        trigger: "!",
        commands: {
          run: {
            description: "Run a workflow.",
            call: ({ args }) => `run:${args}`,
          },
        },
      })],
    }, runtime(), { prompt: "Please !run checks" })

    expect(resolved.input.prompt).toBe("Please run:checks")
  })

  it("validates command definitions", async () => {
    const { inputCommands } = await import("../src/capabilities.ts")

    expect(() => inputCommands({
      commands: {
        Review: { description: "Review.", call: () => undefined },
      },
    })).toThrow("lowercase stable identifier")

    expect(inputCommands({
      commands: {
        review: { call: () => undefined },
      },
    }).metadata).toMatchObject({ commands: { review: {} } })

    expect(() => inputCommands({
      commands: {
        review: { description: "", call: () => undefined },
      },
    })).toThrow("description must be a non-empty string")

    expect(() => inputCommands({
      commands: {
        review: { description: "Review.", call: () => undefined, channels: [""] },
      },
    })).toThrow("channels must be non-empty Channel IDs")
  })

  it("leaves unknown commands unchanged", async () => {
    const { inputCommands } = await import("../src/capabilities.ts")
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")

    const resolved = await resolveAgentCapabilities({
      capabilities: [inputCommands({
        commands: {
          known: { description: "Known.", call: () => "changed" },
        },
      })],
    }, runtime(), { prompt: "Please /unknown value" })

    expect(resolved.input.prompt).toBe("Please /unknown value")
  })

  it("runs multiple commands sequentially in textual order", async () => {
    const { inputCommands } = await import("../src/capabilities.ts")
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    const order: string[] = []

    const resolved = await resolveAgentCapabilities({
      capabilities: [inputCommands({
        commands: {
          first: {
            description: "First.",
            call: ({ args }) => {
              order.push(`first:${args}`)
              return { context: { value: "first" } }
            },
          },
          second: {
            description: "Second.",
            call: ({ args }) => {
              order.push(`second:${args}`)
              return { context: { value: "second" } }
            },
          },
        },
      })],
    }, runtime(), { prompt: "/first one /second two" })

    expect(order).toEqual(["first:one", "second:two"])
    expect(resolved.input.context).toEqual({ value: "second" })
    expect(resolved.input.prompt).toBe("")
  })

  it("scans long command chains without recursive lookahead", async () => {
    const { inputCommands } = await import("../src/capabilities.ts")
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    const run = vi.fn(({ text }) => text)

    const prompt = Array.from({ length: 6_000 }, (_, index) => `/mark ${index}`).join(" ")
    await resolveAgentCapabilities({
      capabilities: [inputCommands({
        commands: {
          mark: {
            description: "Mark the input.",
            call: run,
          },
        },
      })],
    }, runtime(), { prompt })

    expect(run).toHaveBeenCalledTimes(6_000)
  })

  it("continues scanning after partial input rewrites command text", async () => {
    const { inputCommands } = await import("../src/capabilities.ts")
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    const order: string[] = []

    const resolved = await resolveAgentCapabilities({
      capabilities: [inputCommands({
        commands: {
          first: {
            description: "First.",
            call: () => {
              order.push("first")
              return { prompt: "/second shifted" }
            },
          },
          second: {
            description: "Second.",
            call: ({ args }) => {
              order.push(`second:${args}`)
              return "done"
            },
          },
        },
      })],
    }, runtime(), { prompt: "Please /first original /second skipped" })

    expect(order).toEqual(["first", "second:shifted"])
    expect(resolved.input.prompt).toBe("done")
  })

  it("continues scanning after string replacements introduce command text", async () => {
    const { inputCommands } = await import("../src/capabilities.ts")
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    const order: string[] = []

    const resolved = await resolveAgentCapabilities({
      capabilities: [inputCommands({
        commands: {
          first: {
            description: "First.",
            call: () => {
              order.push("first")
              return "/second injected"
            },
          },
          second: {
            description: "Second.",
            call: ({ args }) => {
              order.push(`second:${args}`)
              return "done"
            },
          },
        },
      })],
    }, runtime(), { prompt: "/first" })

    expect(order).toEqual(["first", "second:injected"])
    expect(resolved.input.prompt).toBe("done")
  })

  it("preserves handler input mutations before applying returned partial input", async () => {
    const { inputCommands } = await import("../src/capabilities.ts")
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")

    const resolved = await resolveAgentCapabilities({
      capabilities: [inputCommands({
        commands: {
          mutate: {
            description: "Mutate input.",
            call: ({ context }) => {
              context.input.set({
                context: { fromHandler: true },
                prompt: "/mutate now",
              })
              return { context: { fromReturn: true } }
            },
          },
        },
      })],
    }, runtime(), { context: { keep: true }, prompt: "/mutate now" })

    expect(resolved.input).toMatchObject({
      context: { fromHandler: true, fromReturn: true },
      prompt: "",
    })
  })

  it("does not overwrite handler text mutations with stale string replacement spans", async () => {
    const { inputCommands } = await import("../src/capabilities.ts")
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")

    const resolved = await resolveAgentCapabilities({
      capabilities: [inputCommands({
        commands: {
          mutate: {
            description: "Mutate input.",
            call: ({ context }) => {
              context.input.set({ prompt: "handler text" })
              return "returned text"
            },
          },
        },
      })],
    }, runtime(), { prompt: "/mutate now" })

    expect(resolved.input.prompt).toBe("handler text")
  })

  it("rescans after void handlers mutate input text", async () => {
    const { inputCommands } = await import("../src/capabilities.ts")
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    const order: string[] = []

    const resolved = await resolveAgentCapabilities({
      capabilities: [inputCommands({
        commands: {
          first: {
            description: "First.",
            call: ({ context }) => {
              order.push("first")
              context.input.set({ prompt: "/second shifted" })
            },
          },
          second: {
            description: "Second.",
            call: ({ args }) => {
              order.push(`second:${args}`)
              return "done"
            },
          },
        },
      })],
    }, runtime(), { prompt: "Please /first original" })

    expect(order).toEqual(["first", "second:shifted"])
    expect(resolved.input.prompt).toBe("done")
  })

  it("preserves separators between chained string replacements", async () => {
    const { inputCommands } = await import("../src/capabilities.ts")
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")

    const resolved = await resolveAgentCapabilities({
      capabilities: [inputCommands({
        commands: {
          first: {
            description: "First.",
            call: ({ args }) => `first:${args}`,
          },
          second: {
            description: "Second.",
            call: ({ args }) => `second:${args}`,
          },
        },
      })],
    }, runtime(), { prompt: "/first one /second two" })

    expect(resolved.input.prompt).toBe("first:one second:two")
  })

  it("no-ops when there is no string prompt or user message text", async () => {
    const { inputCommands } = await import("../src/capabilities.ts")
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    const run = vi.fn()
    const input = { messages: [createMessage({ role: "assistant", text: "/review this" })] }

    const resolved = await resolveAgentCapabilities({
      capabilities: [inputCommands({
        commands: {
          review: { call: run, description: "Review." },
        },
      })],
    }, runtime(), input)

    expect(run).not.toHaveBeenCalled()
    expect(resolved.input).toBe(input)
  })
})
