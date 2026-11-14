// An Agent asks a person in Slack to fill in a form: the Agent's tool posts a card with a button, the click opens a
// Slack modal drawn from the form, a bad answer comes back as modal errors, and a good answer starts the next turn.
import { createHmac } from "node:crypto"

import { createSlackAdapter } from "@chat-adapter/slack"
import { defineForm } from "@vite-hub/forms"
import * as v from "valibot"
import { afterEach, describe, expect, it, vi } from "vitest"

import { forms } from "../src/capabilities/forms.ts"
import { slack } from "../src/channels.ts"
import { defineAgent, runAgent } from "../src/index.ts"
import { createChannelWebhookRouteHandler } from "../src/server/internal.ts"

import type { AgentRunContext } from "../src/index.ts"
import type { Adapter } from "chat"

vi.setConfig({ testTimeout: 30_000 })

const expense = defineForm({
  schema: v.object({
    email: v.pipe(v.string(), v.email("Enter a valid email.")),
    amount: v.pipe(v.number(), v.minValue(1, "Enter 1 or more.")),
    reason: v.picklist(["travel", "food"]),
  }),
})

const signingSecret = "test-secret"
const webhookUrl = "https://example.com/api/_vitehub/agents/support/webhooks/slack"

interface SlackBlock {
  type: string
  block_id?: string
  element?: { type: string, action_id: string }
  elements?: { type: string, action_id?: string, value?: string, text?: { text: string } }[]
}

interface SlackView {
  callback_id: string
  private_metadata?: string
  title: { text: string }
  blocks: SlackBlock[]
}

function signed(body: string, contentType: string): Request {
  const timestamp = String(Math.floor(Date.now() / 1000))
  const signature = `v0=${createHmac("sha256", signingSecret).update(`v0:${timestamp}:${body}`).digest("hex")}`
  return new Request(webhookUrl, {
    body,
    headers: { "content-type": contentType, "x-slack-request-timestamp": timestamp, "x-slack-signature": signature },
    method: "POST",
  })
}

function lastUserText({ messages }: AgentRunContext): string {
  const parts = messages.filter(message => message.role === "user").at(-1)?.parts ?? []
  return parts.map(part => part.type === "text" ? part.text : "").join("")
}

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

/** The Chat SDK Slack adapter with a fake Slack Web API, behind the Agent's channel webhook route. */
function slackFixture() {
  const adapter = createSlackAdapter({ botToken: "xoxb-test", signingSecret })
  const posted: { blocks?: SlackBlock[], markdown_text?: string, text?: string, thread_ts?: string, ts: string }[] = []
  const updated: { blocks?: SlackBlock[], text?: string, ts: string }[] = []
  const opened: SlackView[] = []
  let ts = 100
  Reflect.set(adapter, "_client", {
    auth: { test: async () => ({ ok: true, user_id: "UBOT", bot_id: "BBOT" }) },
    chat: {
      postMessage: async (args: { blocks?: SlackBlock[], markdown_text?: string, text?: string, thread_ts?: string }) => {
        const message = { ...args, ts: `1700000000.000${++ts}` }
        posted.push(message)
        return { ok: true, ts: message.ts, message }
      },
      update: async (args: { blocks?: SlackBlock[], text?: string, ts: string }) => {
        updated.push(args)
        return { ok: true, ts: args.ts }
      },
    },
    conversations: {
      info: async () => ({ ok: true, channel: { id: "C1", name: "expenses" } }),
      replies: async () => ({ ok: true, messages: [] }),
    },
    users: { info: async () => ({ ok: true, user: { id: "U1", name: "ada", real_name: "Ada" } }) },
    views: {
      open: async (args: { view: SlackView }) => {
        opened.push(args.view)
        return { ok: true, view: { id: "V1" } }
      },
    },
  })
  const runs: string[] = []
  const agent = defineAgent({
    capabilities: [forms({ expense })],
    // SAFETY: The Slack adapter implements the Chat SDK Adapter that the Channel calls.
    channels: { slack: slack({ adapter: adapter as unknown as Adapter, messages: { stream: false } }) },
    driver: {
      async run(context) {
        const text = lastUserText(context)
        runs.push(text)
        if (text.includes("expense")) {
          const result = await context.tools!.ask_expense!.execute!({ message: "I need the details of your trip." }, { toolCallId: "call-1" })
          expect(result).toMatchObject({ status: "asked", form: "expense" })
          return { text: "Fill in the form with the button." }
        }
        return { text: "Saved your expense." }
      },
    },
    name: "support",
    runtime: false,
  })
  // SAFETY: The test agent has the shape that the route handler reads.
  const handler = createChannelWebhookRouteHandler(agent as never)
  const send = (request: Request) => handler(request, "slack", { agentIdentity: { name: "support" } })
  return { opened, posted, runs, send, updated }
}

function viewSubmission(view: SlackView, values: Record<string, string>) {
  const state: Record<string, Record<string, unknown>> = {}
  for (const block of view.blocks) {
    if (block.type !== "input" || !block.element || !block.block_id) continue
    const value = values[block.block_id]
    const { type, action_id } = block.element
    state[block.block_id] = { [action_id]: type === "static_select" || type === "radio_buttons" ? { type, selected_option: { value } } : { type, value } }
  }
  const payload = { type: "view_submission", user: { id: "U1", name: "ada" }, view: { id: "V1", callback_id: view.callback_id, private_metadata: view.private_metadata, state: { values: state } } }
  return signed(new URLSearchParams({ payload: JSON.stringify(payload) }).toString(), "application/x-www-form-urlencoded")
}

describe("an Agent asks for a form in Slack", () => {
  it("posts a button, opens the form on a click, shows errors in the modal, and starts the next turn with the values", async () => {
    const slack = slackFixture()

    // 1. A person mentions the Agent. The Agent's tool asks for the expense form.
    const mention = { type: "event_callback", team_id: "T1", api_app_id: "A1", event_id: "Ev1", event_time: 1700000000, event: { type: "app_mention", user: "U1", text: "<@UBOT> I want to file an expense", ts: "1700000000.000001", channel: "C1", event_ts: "1700000000.000001" } }
    expect((await slack.send(signed(JSON.stringify(mention), "application/json"))).status).toBe(200)
    await vi.waitFor(() => expect(slack.posted.some(message => message.blocks?.some(block => block.type === "actions"))).toBe(true))
    const card = slack.posted.find(message => message.blocks?.some(block => block.type === "actions"))!
    const button = card.blocks!.flatMap(block => block.elements ?? []).find(element => element.type === "button")!
    expect(button.text?.text).toBe("Fill in Expense")
    expect(card.thread_ts).toBe("1700000000.000001")

    // 2. The click opens a Slack modal with one input for each field of the form.
    const click = { type: "block_actions", user: { id: "U1", username: "ada", name: "Ada" }, trigger_id: "trigger-1", channel: { id: "C1" }, container: { type: "message", channel_id: "C1", message_ts: card.ts, thread_ts: "1700000000.000001" }, message: { ts: card.ts, thread_ts: "1700000000.000001" }, actions: [{ type: "button", action_id: button.action_id, value: button.value, block_id: "actions" }] }
    expect((await slack.send(signed(new URLSearchParams({ payload: JSON.stringify(click) }).toString(), "application/x-www-form-urlencoded"))).status).toBe(200)
    await vi.waitFor(() => expect(slack.opened).toHaveLength(1))
    const view = slack.opened[0]!
    expect(view.title.text).toBe("Expense")
    expect(view.blocks.filter(block => block.type === "input").map(block => block.block_id)).toEqual(["email", "amount", "reason"])

    // 3. Bad values come back as errors under their inputs, and the Agent does not run.
    const invalid = await slack.send(viewSubmission(view, { email: "ada", amount: "0", reason: "travel" }))
    expect(await invalid.json()).toEqual({ response_action: "errors", errors: { email: "Enter a valid email.", amount: "Enter 1 or more." } })
    expect(slack.runs).toHaveLength(1)

    // 4. Good values close the modal, mark the card as answered, and start the next turn with the checked values.
    const valid = await slack.send(viewSubmission(view, { email: "ada@example.com", amount: "42", reason: "food" }))
    expect(await valid.text()).toBe("")
    await vi.waitFor(() => expect(slack.runs).toHaveLength(2))
    const answer = slack.runs[1]!
    expect(answer).toContain("Expense")
    expect(JSON.parse(answer.slice(answer.indexOf("{"), answer.lastIndexOf("}") + 1))).toEqual({ email: "ada@example.com", amount: 42, reason: "food" })
    await vi.waitFor(() => expect(slack.posted.some(message => message.markdown_text === "Saved your expense.")).toBe(true))
    expect(slack.updated.some(message => message.ts === card.ts && !message.blocks?.some(block => block.type === "actions"))).toBe(true)

    // 5. A second answer to the same tool call, such as from a second open modal, starts no turn.
    await slack.send(viewSubmission(view, { email: "ada@example.com", amount: "7", reason: "travel" }))
    await new Promise(resolve => setTimeout(resolve, 500))
    expect(slack.runs).toHaveLength(2)
  })
})

describe("an Agent asks for a form where no chat can show it", () => {
  it("returns the fields so the Agent asks for them in the conversation", async () => {
    let result: unknown
    const agent = defineAgent({
      capabilities: [forms({ expense })],
      driver: {
        async run(context) {
          result = await context.tools!.ask_expense!.execute!({ message: "I need the details of your trip." }, { toolCallId: "call-1" })
          return { text: "ok" }
        },
      },
      name: "support",
      runtime: false,
    })
    const [error] = await runAgent(agent, { prompt: "I want to file an expense" })
    expect(error).toBeUndefined()
    expect(result).toMatchObject({
      status: "unavailable",
      form: "expense",
      fields: [
        { name: "email", label: "Email", type: "string", required: true },
        { name: "amount", label: "Amount", type: "number", required: true },
        { name: "reason", label: "Reason", type: "string", required: true, options: ["travel", "food"] },
      ],
    })
  })
})

describe("forms()", () => {
  it.each([
    ["no forms", {}],
    ["a value that is not a form", { expense: { schema: v.object({}) } }],
    ["a name that is not a tool name", { "my expense": expense }],
    ["an empty title", { expense: { form: expense, title: " " } }],
  ])("throws AGENT_FORMS_INVALID for %s", (_label, input) => {
    // SAFETY: Each case passes a value that the types refuse, as JavaScript callers can.
    expect(() => forms(input as never)).toThrow(expect.objectContaining({ code: "AGENT_FORMS_INVALID" }))
  })
})
