import { describe, expect, it, vi } from "vitest"

import { createMessage, getMessageText } from "../src/messages.ts"

const runtime = () => ({
  memo: vi.fn(),
  runtime: "unknown" as const,
  runtimeConfig: {},
  waitUntil: vi.fn(),
})

describe("inputCommands", () => {
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
            run: ({ args }) => args,
          },
        },
      })],
    }, runtime(), { prompt: "/summary" })

    expect(resolved.input.prompt).toBe("/summary")
  })

  it("uses command args as the default command rewrite", async () => {
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

    expect(resolved.input.prompt).toBe("auth changes")
  })

  it("keeps command-only message text when a string handler returns empty args", async () => {
    const { inputCommands } = await import("../src/capabilities.ts")
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")

    const resolved = await resolveAgentCapabilities({
      capabilities: [inputCommands({
        commands: {
          review: {
            description: "Review the request.",
            run: ({ args }) => args,
          },
        },
      })],
    }, runtime(), { messages: [createMessage({ role: "user", text: "/review" })] })

    expect(resolved.input.messages?.map(message => getMessageText(message))).toEqual(["/review"])
  })

  it("replaces command text from an initial message", async () => {
    const { inputCommands } = await import("../src/capabilities.ts")
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")

    const resolved = await resolveAgentCapabilities({
      capabilities: [inputCommands({
        commands: {
          review: {
            description: "Review the request.",
            run: ({ args }) => `Review this: ${args}`,
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
            run: ({ args }) => `review:${args}`,
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
            run: ({ args }) => `review:${args}`,
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
            run: ({ args }) => `review:${args}`,
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
            run: ({ args }) => `review:${args}`,
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
            run: ({ args }) => `review:${args}`,
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
            run: ({ args }) => ({
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
            run: ({ args }) => ({ context: { review: { args } } }),
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
            run: () => Response.json({ accepted: false }),
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
            run: () => ({ messages: [message] }),
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
            run: () => ({ prompt: "rewritten" }),
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
      inputCommands({ commands: { one: { description: "One.", run: () => undefined } } }),
      inputCommands({ commands: { two: { description: "Two.", run: () => undefined } } }),
    ])).toThrow("Duplicate capability id")

    const resolved = await resolveAgentCapabilities({
      capabilities: [
        inputCommands({
          commands: { one: { description: "One.", run: () => "one" } },
        }),
        inputCommands({
          id: "bangCommands",
          trigger: "!",
          commands: { two: { description: "Two.", run: () => "two" } },
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
            run: ({ args }) => `run:${args}`,
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
        Review: { description: "Review.", run: () => undefined },
      },
    })).toThrow("lowercase stable identifier")

    expect(inputCommands({
      commands: {
        review: { run: () => undefined },
      },
    }).metadata).toMatchObject({ commands: { review: {} } })

    expect(() => inputCommands({
      commands: {
        review: { description: "", run: () => undefined },
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
          known: { description: "Known.", run: () => "changed" },
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
            run: ({ args }) => {
              order.push(`first:${args}`)
              return { context: { value: "first" } }
            },
          },
          second: {
            description: "Second.",
            run: ({ args }) => {
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
            run,
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
            run: () => {
              order.push("first")
              return { prompt: "/second shifted" }
            },
          },
          second: {
            description: "Second.",
            run: ({ args }) => {
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
            run: () => {
              order.push("first")
              return "/second injected"
            },
          },
          second: {
            description: "Second.",
            run: ({ args }) => {
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
            run: ({ context }) => {
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
            run: ({ context }) => {
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
            run: ({ context }) => {
              order.push("first")
              context.input.set({ prompt: "/second shifted" })
            },
          },
          second: {
            description: "Second.",
            run: ({ args }) => {
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
            run: ({ args }) => `first:${args}`,
          },
          second: {
            description: "Second.",
            run: ({ args }) => `second:${args}`,
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
          review: { description: "Review.", run },
        },
      })],
    }, runtime(), input)

    expect(run).not.toHaveBeenCalled()
    expect(resolved.input).toBe(input)
  })
})
