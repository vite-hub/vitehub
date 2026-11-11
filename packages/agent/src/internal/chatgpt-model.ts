import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4Content,
  LanguageModelV4FinishReason,
  LanguageModelV4GenerateResult,
  LanguageModelV4StreamPart,
  LanguageModelV4StreamResult,
  LanguageModelV4Usage,
  SharedV4ProviderMetadata,
  SharedV4Warning,
} from "@ai-sdk/provider"
import type { ChatGPTCredential } from "@vite-hub/connections/agent"
import type { ChatGPTGateway } from "@vite-hub/gateways"
import { agentDiagnostics } from "../agent-diagnostics.ts"
import type { AgentProviderCredentialContext } from "../types.ts"
import { chatgptProviderError, resolveChatGPTCredential } from "./chatgpt-gateway.ts"
import { isRecord } from "@vite-hub/internal/object"

/** Request fields that ChatGPT plan usage rejects. History goes in `input`, so `previous_response_id` goes too. */
const rejectedFields = [
  "background", "conversation", "max_output_tokens", "max_tool_calls", "metadata", "moderation", "multi_agent",
  "previous_response_id", "prompt", "prompt_cache_retention", "safety_identifier", "temperature", "top_logprobs",
  "top_p", "truncation", "user",
]

const toolNamespace = { name: "functions", description: "The tools of this Agent." }

/** The request that plan usage accepts: `store: false`, `stream: true`, no rejected field, and no `system` role. */
export function chatgptPlanRequest(body: unknown): Record<string, unknown> {
  if (!isRecord(body)) throw agentDiagnostics.AGENT_R1021()
  const request: Record<string, unknown> = { ...body, store: false, stream: true }
  for (const field of rejectedFields) delete request[field]
  // Only web search and namespaces of local function/custom tools are supported. The SDK cannot namespace its
  // provider-defined custom tools, so reject those top-level tools rather than sending an unsupported request.
  if (Array.isArray(request.tools) && request.tools.some(tool => {
    if (!isRecord(tool)) return true
    if (tool.type === "web_search" || tool.type === "web_search_preview") return false
    return tool.type !== "namespace" || !Array.isArray(tool.tools)
      || tool.tools.some(nested => !isRecord(nested) || (nested.type !== "function" && nested.type !== "custom"))
  })) {
    throw agentDiagnostics.AGENT_R1019()
  }
  if (Array.isArray(request.input)) {
    request.input = request.input.map(item => isRecord(item) && item.role === "system" ? { ...item, role: "developer" } : item)
  }
  return request
}

/**
 * A fetch that sends only `POST <api>/responses` and adds the grant there. The AI SDK never holds the token, and an
 * error body cannot echo it back.
 */
function chatgptPlanFetch(credential: ChatGPTCredential): typeof fetch {
  const endpoint = `${credential.api.replace(/\/$/, "")}/responses`
  return async (input, init) => {
    const url = input instanceof Request ? input.url : String(input)
    if (url !== endpoint || init?.method?.toUpperCase() !== "POST" || typeof init.body !== "string") {
      throw agentDiagnostics.AGENT_R1021()
    }
    if (Date.now() >= credential.expiresAt) throw agentDiagnostics.AGENT_R1024()
    const headers = new Headers(init.headers)
    headers.set("authorization", `Bearer ${credential.accessToken}`)
    // Codex sends the app name as `originator`. Plan usage attributes requests to the app with it.
    if (/^[\x20-\x7E]+$/.test(credential.clientInfo.name)) headers.set("originator", credential.clientInfo.name)
    // Cloudflare Workers reject `redirect: "error"`, so refuse a redirect by its status.
    const response = await fetch(endpoint, { ...init, headers, body: JSON.stringify(chatgptPlanRequest(JSON.parse(init.body))), redirect: "manual" })
    if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) throw agentDiagnostics.AGENT_R1021()
    if (response.ok) return response
    const text = (await response.text()).replaceAll(credential.accessToken, "[REDACTED]")
    return new Response(text, { status: response.status, statusText: response.statusText, headers: response.headers })
  }
}

/** The text that names a provider error code, from an AI SDK error, a stream error part, or a response body. */
function providerErrorText(error: unknown): string {
  if (typeof error === "string") return error
  if (!isRecord(error) && !(error instanceof Error)) return ""
  const parts = [error instanceof Error ? error.message : ""]
  for (const key of ["responseBody", "data", "error", "response", "cause", "code", "statusCode"]) {
    const value: unknown = Reflect.get(error, key)
    if (value === undefined) continue
    try {
      parts.push(typeof value === "string" ? value : JSON.stringify(value))
    }
    catch {}
  }
  return parts.join(" ")
}

function planError(error: unknown, connection: string): unknown {
  return chatgptProviderError(providerErrorText(error), connection) ?? error
}

function mergeMetadata(left: SharedV4ProviderMetadata | undefined, right: SharedV4ProviderMetadata | undefined): SharedV4ProviderMetadata | undefined {
  if (!left) return right
  if (!right) return left
  const merged: SharedV4ProviderMetadata = { ...left }
  for (const [key, value] of Object.entries(right)) merged[key] = { ...merged[key], ...value }
  return merged
}

/** Plan usage accepts only streamed requests, so a generate call reads the stream into one result. */
export async function collectStream(result: LanguageModelV4StreamResult): Promise<LanguageModelV4GenerateResult> {
  const content: LanguageModelV4Content[] = []
  const open = new Map<string, Extract<LanguageModelV4Content, { type: "text" | "reasoning" }>>()
  let warnings: SharedV4Warning[] = []
  let finishReason: LanguageModelV4FinishReason = { unified: "other", raw: undefined }
  let usage: LanguageModelV4Usage | undefined
  let providerMetadata: SharedV4ProviderMetadata | undefined
  let response: LanguageModelV4GenerateResult["response"]
  const reader = result.stream.getReader()
  const close = (id: string, metadata: SharedV4ProviderMetadata | undefined) => {
    const part = open.get(id)
    if (!part) return
    open.delete(id)
    part.providerMetadata = mergeMetadata(part.providerMetadata, metadata)
  }
  for (;;) {
    const { done, value: part } = await reader.read()
    if (done) break
    switch (part.type) {
      case "stream-start": warnings = part.warnings; break
      case "response-metadata": response = { ...response, ...part }; break
      case "text-start":
      case "reasoning-start": {
        const current: Extract<LanguageModelV4Content, { type: "text" | "reasoning" }> = {
          type: part.type === "text-start" ? "text" : "reasoning", text: "", providerMetadata: part.providerMetadata,
        }
        open.set(part.id, current)
        content.push(current)
        break
      }
      case "text-delta":
      case "reasoning-delta": {
        const current = open.get(part.id)
        if (current) {
          current.text += part.delta
          current.providerMetadata = mergeMetadata(current.providerMetadata, part.providerMetadata)
        }
        break
      }
      case "text-end":
      case "reasoning-end": close(part.id, part.providerMetadata); break
      case "tool-input-start":
      case "tool-input-delta":
      case "tool-input-end":
      case "raw":
        break
      case "error": throw part.error
      case "finish":
        finishReason = part.finishReason
        usage = part.usage
        providerMetadata = part.providerMetadata
        break
      default: content.push(part)
    }
  }
  if (!usage) throw agentDiagnostics.AGENT_R1023()
  return {
    content, finishReason, usage, warnings,
    ...(providerMetadata ? { providerMetadata } : {}),
    ...(result.request ? { request: result.request } : {}),
    response: { ...response, ...result.response },
  }
}

/**
 * An AI SDK model on the ChatGPT plan of a Connection. It calls the Responses API over HTTP, so it runs on every host,
 * including Cloudflare Workers. Each model call resolves a fresh grant through the Connection.
 */
export function chatgptLanguageModel(gateway: ChatGPTGateway, modelId: string, context: AgentProviderCredentialContext): LanguageModelV4 {
  const doStream = async (options: LanguageModelV4CallOptions): Promise<LanguageModelV4StreamResult> => {
    const abortSignal = options.abortSignal ?? context.abortSignal
    const credential = await resolveChatGPTCredential(gateway, { ...context, abortSignal })
    const { createOpenAI } = await import("@ai-sdk/openai")
    // The key is a placeholder: the fetch adds the grant to the one request that it allows.
    const model = createOpenAI({ name: "chatgpt", apiKey: "chatgpt-plan", baseURL: credential.api, fetch: chatgptPlanFetch(credential) }).responses(modelId)
    const openai = options.providerOptions?.openai ?? {}
    const include = Array.isArray(openai.include) ? openai.include.filter(value => typeof value === "string") : []
    try {
      const result = await model.doStream({
        ...options,
        abortSignal,
        // Plan usage takes function tools in a namespace, as Codex sends them.
        ...(options.tools ? { tools: options.tools.map(tool => tool.type === "function" ? { ...tool, providerOptions: { ...tool.providerOptions, openai: { ...tool.providerOptions?.openai, namespace: toolNamespace } } } : tool) } : {}),
        maxOutputTokens: undefined,
        temperature: undefined,
        topP: undefined,
        providerOptions: {
          ...options.providerOptions,
          // `store: false` sends earlier reasoning back as encrypted content instead of stored item references.
          openai: { ...openai, store: false, systemMessageMode: "developer", include: [...new Set([...include, "reasoning.encrypted_content"])] },
        },
      })
      return {
        ...result,
        stream: result.stream.pipeThrough(new TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart>({
          transform(part, controller) {
            controller.enqueue(part.type === "error" ? { type: "error", error: planError(part.error, gateway.connection) } : part)
          },
        })),
      }
    }
    catch (error) {
      abortSignal?.throwIfAborted()
      throw planError(error, gateway.connection)
    }
  }
  return {
    specificationVersion: "v4",
    provider: "chatgpt",
    modelId,
    supportedUrls: {},
    doStream,
    doGenerate: async options => await collectStream(await doStream(options)),
  }
}
