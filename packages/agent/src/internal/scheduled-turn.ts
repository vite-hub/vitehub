import type {
  AgentChannelDeliveryFinishEffectCallback,
  AgentInvoker,
  AgentRunMetadata,
} from "../types.ts"

export const scheduledAgentNameContextKey = "agent.name"
export const scheduledAgentTurnContextKey = "agent.schedule.turn"

const scheduledAgentName = Symbol("vitehub.agent.name")

export interface ScheduledAgentTurnDelivery {
  channelId: string
  origin: string
  threadId: string
}

export interface ScheduledAgentTurnInput {
  delivery?: ScheduledAgentTurnDelivery
  invoker: AgentInvoker
  kind: "agent-turn"
  prompt: string
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`[vitehub] ${label} must be a non-empty string.`)
  }
  return value.trim()
}

function optionalString(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : requiredString(value, label)
}

function assertExactKeys(value: Record<PropertyKey, unknown>, keys: readonly string[], label: string): void {
  const unknownKey = Object.keys(value).find(key => !keys.includes(key))
  if (unknownKey) throw new TypeError(`[vitehub] ${label} does not support "${unknownKey}".`)
}

function durableInvoker(value: unknown): AgentInvoker {
  if (!isRecord(value)) {
    throw new TypeError("[vitehub] Scheduled Agent turn durable invoker must be an object.")
  }
  assertExactKeys(value, ["email", "id", "kind", "label"], "Scheduled Agent turn durable invoker")
  const email = value.email
  if (email !== undefined) {
    if (!isRecord(email)) throw new TypeError("[vitehub] Scheduled Agent turn durable invoker email must be an object.")
    assertExactKeys(email, ["address", "domain"], "Scheduled Agent turn durable invoker email")
  }
  const kind = optionalString(value.kind, "Scheduled Agent turn durable invoker kind")
  const label = optionalString(value.label, "Scheduled Agent turn durable invoker label")
  return {
    ...(email
      ? {
          email: {
            address: requiredString(email.address, "Scheduled Agent turn durable invoker email address"),
            domain: requiredString(email.domain, "Scheduled Agent turn durable invoker email domain"),
          },
        }
      : {}),
    id: requiredString(value.id, "Scheduled Agent turn durable invoker id"),
    ...(kind ? { kind } : {}),
    ...(label ? { label } : {}),
  }
}

function durableInvokerFromCurrent(value: AgentInvoker): AgentInvoker {
  const { meta: _meta, ...durable } = value
  return durableInvoker(durable)
}

function durableDelivery(value: unknown): ScheduledAgentTurnDelivery {
  if (!isRecord(value)) {
    throw new TypeError("[vitehub] Scheduled Agent turn delivery must be an object.")
  }
  assertExactKeys(value, ["channelId", "origin", "threadId"], "Scheduled Agent turn delivery")
  return {
    channelId: requiredString(value.channelId, "Scheduled Agent turn delivery channelId"),
    origin: requiredString(value.origin, "Scheduled Agent turn delivery origin"),
    threadId: requiredString(value.threadId, "Scheduled Agent turn delivery threadId"),
  }
}

export function createScheduledAgentTurnInput(
  prompt: unknown,
  invoker: AgentInvoker,
  run: AgentRunMetadata | undefined,
  delivery: "origin" | undefined,
): ScheduledAgentTurnInput {
  if (delivery === "origin" && (!run?.channelId || !run.threadId || !run.origin)) {
    throw new Error('[vitehub] schedule({ delivery: "origin" }) requires channelId and threadId from a named run origin.')
  }
  return {
    ...(delivery === "origin"
      ? {
          delivery: durableDelivery({
            channelId: run?.channelId,
            origin: run?.origin,
            threadId: run?.threadId,
          }),
        }
      : {}),
    invoker: durableInvokerFromCurrent(invoker),
    kind: "agent-turn",
    prompt: requiredString(prompt, "cronjob prompt"),
  }
}

export function parseScheduledAgentTurnInput(value: unknown): ScheduledAgentTurnInput {
  if (!isRecord(value)) throw new TypeError("[vitehub] Scheduled Agent turn input must be an object.")
  assertExactKeys(value, ["delivery", "invoker", "kind", "prompt"], "Scheduled Agent turn input")
  if (value.kind !== "agent-turn") throw new TypeError("[vitehub] Scheduled Agent turn input kind must be agent-turn.")
  return {
    ...(value.delivery === undefined ? {} : { delivery: durableDelivery(value.delivery) }),
    invoker: durableInvoker(value.invoker),
    kind: "agent-turn",
    prompt: requiredString(value.prompt, "Scheduled Agent turn prompt"),
  }
}

export function scheduledAgentTurnPrompt(value: unknown): string | undefined {
  if (!isRecord(value) || value.kind !== "agent-turn" || typeof value.prompt !== "string" || !value.prompt.trim()) return
  return value.prompt.trim()
}

export function scheduledAgentTargetName(name: string | undefined): string | undefined {
  return name ? `agent/${name}` : undefined
}

export function getScheduledAgentName(value: unknown): string | undefined {
  if (!isRecord(value)) return
  return optionalString(value[scheduledAgentName], "Discovered Agent name")
}

export function setScheduledAgentName(value: object, name: string): void {
  Object.defineProperty(value, scheduledAgentName, {
    configurable: true,
    value: requiredString(name, "Discovered Agent name"),
  })
}

export const scheduledAgentTurnReplyEffect: AgentChannelDeliveryFinishEffectCallback = (finish) => {
  const text = finish.result?.text ?? finish.text
  return text ? finish.reply(text) : undefined
}
