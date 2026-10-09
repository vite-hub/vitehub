import type { TraceEventLogEntry } from "@vite-hub/runtime"
import { hasRuntimeType } from "./runtime-type.ts"
import { consumeAuthorization, consumeCredentialAssignment, credentialTextLineContext, credentialTextMayContinue, pendingAuthorizationState, pendingCredentialAssignmentState, pendingCredentialQuote, pendingCredentialScheme, pendingCredentialTextSuffix, pendingCredentialUri, redactCredentialText } from "./credential-redaction.ts"
import type { AuthorizationState, CredentialAssignmentState } from "./credential-redaction.ts"

export const AGENT_INVOCATION_OBSERVATION_TRUNCATED_ATTRIBUTE = "vitehub.observation.truncated"

/** Applies stream-safe redaction and buffering after the journal content policy. */
export function createInvocationObservationStream(options: {
  emit: (entry: TraceEventLogEntry) => void
  maxMessageDeltaCharacters: number
  maxMessageDeltaKeys: number
}) {
  const { emit, maxMessageDeltaCharacters, maxMessageDeltaKeys } = options
  const messageDeltaChunkCharacters = maxMessageDeltaCharacters
  const messageDeltaChunkEvents = 32
  const maxPendingCredentialCharacters = Math.max(messageDeltaChunkCharacters, 512)
  const admittedMessageDeltaKeys = new Set<string>()
  let messageDeltaKeysTruncated = false
  let activeMessageDeltaKey: string | undefined
  const precedingMessageText = new Map<string, string>()
  const pendingMessageDeltas = new Map<string, { entry: TraceEventLogEntry, events: number }>()
  const redactingCredentialDeltas = new Map<string, { kind: "uri" } | { kind: "authorization", state: AuthorizationState } | { kind: "shell", state: CredentialAssignmentState } | { kind: "unquoted" | "scheme", escaped?: boolean } | { kind: "quoted", quote: string, escaped: boolean, omitClosingQuote?: boolean }>()
  const messageDeltaKey = (entry: TraceEventLogEntry) => JSON.stringify([
    entry.attributes?.["message.id"],
    entry.attributes?.["message.phase"],
    entry.attributes?.["message.role"],
    entry.attributes?.["vitehub.auxiliary.kind"],
  ])
  const flushMessageDelta = (key: string, final = true, interveningEvent = false) => {
    const pending = pendingMessageDeltas.get(key)
    if (!pending) return
    const rawContent = pending.entry.attributes?.["message.content"]
    let retainedContent: string | undefined
    if (hasRuntimeType(rawContent, "string")) {
      let content = rawContent
      const precedingText = precedingMessageText.get(key) ?? ""
      if (!final && credentialTextMayContinue(content, precedingText)) {
        if (!interveningEvent && content.length < maxPendingCredentialCharacters) return
        const quote = pendingCredentialQuote(content, precedingText)
        const scheme = pendingCredentialScheme(content, precedingText)
        const assignment = pendingCredentialAssignmentState(content, precedingText)
        const authorization = pendingAuthorizationState(content)
        const uri = pendingCredentialUri(content)
        if (authorization) {
          redactingCredentialDeltas.set(key, { kind: "authorization", state: authorization })
        }
        else if (assignment) {
          redactingCredentialDeltas.set(key, { kind: "shell", state: assignment })
          // Complete only the persisted placeholder; the scanner retains the raw state.
          if (!assignment.started) content += "[REDACTED]"
          else if (assignment.quote) content += `${assignment.escaped ? "\\" : ""}${assignment.quote}`
        }
        else if (uri && content.length - uri.start < maxPendingCredentialCharacters) {
          // An event boundary does not prove that an authority is userinfo.
          // Keep the bounded suffix until its URI boundary or stream completion.
          retainedContent = content.slice(uri.start)
          content = content.slice(0, uri.start)
        }
        else if (uri) {
          pending.entry = {
            ...pending.entry,
            attributes: { ...pending.entry.attributes, [AGENT_INVOCATION_OBSERVATION_TRUNCATED_ATTRIBUTE]: true },
          }
          redactingCredentialDeltas.set(key, { kind: "uri" })
          content = content.slice(0, uri.start) + uri.prefix + "[REDACTED]"
        }
        else if (quote) {
          redactingCredentialDeltas.set(key, { kind: "quoted", quote, escaped: (content.match(/\\+$/)?.[0].length ?? 0) % 2 === 1 })
        }
        else if (scheme) {
          redactingCredentialDeltas.set(key, {
            kind: scheme,
            escaped: (content.match(/\\+$/)?.[0].length ?? 0) % 2 === 1,
          })
          if (scheme === "scheme") {
            content += "[REDACTED]"
          }
        }
        else {
          // A possible marker is still ordinary text until its separator arrives.
          retainedContent = pendingCredentialTextSuffix(content)
          if (retainedContent) {
            content = content.slice(0, -retainedContent.length)
            if (retainedContent.length >= maxPendingCredentialCharacters) {
              pending.entry = {
                ...pending.entry,
                attributes: { ...pending.entry.attributes, [AGENT_INVOCATION_OBSERVATION_TRUNCATED_ATTRIBUTE]: true },
              }
              content += "[REDACTED]"
              redactingCredentialDeltas.set(key, { kind: "unquoted" })
              retainedContent = undefined
            }
          }
        }
      }
      // A scheme name can itself be split before its colon. Retain a bounded
      // trailing word even when no credential marker has been established yet.
      else if (!final && !interveningEvent) {
        retainedContent = /\b[a-z][a-z0-9+.-]*$/i.exec(content.slice(-128))?.[0]
        if (retainedContent) content = content.slice(0, -retainedContent.length)
      }
      const redacted = redactCredentialText(content, precedingText)
      // Retain only line and authorization-header context, never credential text.
      const emittedRaw = rawContent.slice(0, rawContent.length - (retainedContent?.length ?? 0))
      precedingMessageText.set(key, credentialTextLineContext(precedingText + emittedRaw))
      for (let offset = 0; offset < redacted.length; offset += messageDeltaChunkCharacters) {
        emit({
          ...pending.entry,
          attributes: {
            ...pending.entry.attributes,
            "message.content": redacted.slice(offset, offset + messageDeltaChunkCharacters),
          },
        })
      }
    } else {
      emit(pending.entry)
    }
    pendingMessageDeltas.delete(key)
    if (retainedContent) {
      pendingMessageDeltas.set(key, {
        entry: { ...pending.entry, attributes: { ...pending.entry.attributes, "message.content": retainedContent } },
        events: 0,
      })
    }
  }
  const flushMessageDeltas = (final = true) => {
    // Flushing may reinsert a retained suffix; visit each original key only once.
    // oxlint-disable-next-line unicorn/no-useless-spread
    for (const key of [...pendingMessageDeltas.keys()]) flushMessageDelta(key, final, true)
  }
  const queueMessageDelta = (entry: TraceEventLogEntry) => {
    const key = messageDeltaKey(entry)
    if (activeMessageDeltaKey !== undefined && activeMessageDeltaKey !== key) {
      flushMessageDelta(activeMessageDeltaKey, false, true)
    }
    activeMessageDeltaKey = key
    if (!admittedMessageDeltaKeys.has(key)) {
      if (admittedMessageDeltaKeys.size >= maxMessageDeltaKeys) {
        if (!messageDeltaKeysTruncated) {
          messageDeltaKeysTruncated = true
          const attributes = { ...entry.attributes }
          delete attributes["message.content"]
          emit({
            ...entry,
            attributes: {
              ...attributes,
              "content.omitted": ["message.content"],
              "content.truncated": true,
            },
          })
        }
        return
      }
      // Keep admission stable for the invocation: accepting a previously dropped
      // stream later could expose a credential continuation without its prefix.
      admittedMessageDeltaKeys.add(key)
    }
    const rawContent = entry.attributes?.["message.content"]
    let content = Object.prototype.toString.call(rawContent) === "[object String]" ? String(rawContent) : undefined
    if (content !== undefined && redactingCredentialDeltas.has(key)) {
      let redaction = redactingCredentialDeltas.get(key)!
      if (redaction.kind === "uri") {
        const boundary = content.search(/[\s/\\?#@"<>]/)
        if (boundary === -1) return
        redactingCredentialDeltas.delete(key)
        content = content.slice(boundary)
        entry = { ...entry, attributes: { ...entry.attributes, "message.content": content } }
      }
      else if (redaction.kind === "shell" || redaction.kind === "authorization") {
        const boundary = redaction.kind === "authorization"
          ? consumeAuthorization(content, redaction.state)
          : consumeCredentialAssignment(content, redaction.state)
        if (boundary === content.length) return
        redactingCredentialDeltas.delete(key)
        content = (redaction.kind === "shell" ? redaction.state.yaml?.whitespace ?? redaction.state.yamlPlain?.pending ?? "" : "") + content.slice(boundary)
        entry = { ...entry, attributes: { ...entry.attributes, "message.content": content } }
      }
      else {
        if (redaction.kind === "scheme") {
          content = content.trimStart()
          if (!content) return
        }
        if (redaction.kind === "scheme" && (content[0] === '"' || content[0] === "'")) {
          redaction = { kind: "quoted", quote: content[0], escaped: false, omitClosingQuote: true }
          redactingCredentialDeltas.set(key, redaction)
          content = content.slice(1)
        }
        let boundary: number
        if (redaction.kind === "quoted") {
          boundary = -1
          for (let index = 0; index < content.length; index++) {
            const character = content[index]
            if (redaction.escaped) redaction.escaped = false
            else if (character === "\\") redaction.escaped = true
            else if (character === redaction.quote) {
              boundary = index + (redaction.omitClosingQuote ? 1 : 0)
              break
            }
          }
        }
        else {
          if (redaction.kind === "scheme") {
            content = content.trimStart()
            if (!content) return
            redaction = { kind: "unquoted" }
            redactingCredentialDeltas.set(key, redaction)
          }
          boundary = -1
          for (let index = 0; index < content.length; index++) {
            const character = content[index]!
            if (redaction.escaped) redaction.escaped = false
            else if (character === "\\") redaction.escaped = true
            else if (/[\s"',;&{}<>]/.test(character)) {
              boundary = index
              break
            }
          }
        }
        if (boundary < 0) return
        redactingCredentialDeltas.delete(key)
        content = content.slice(boundary)
        entry = { ...entry, attributes: { ...entry.attributes, "message.content": content } }
      }
    }
    const pending = pendingMessageDeltas.get(key)
    const rawPreviousContent = pending?.entry.attributes?.["message.content"]
    const previousContent = Object.prototype.toString.call(rawPreviousContent) === "[object String]"
      ? String(rawPreviousContent)
      : undefined
    if (pending && (previousContent === undefined) === (content === undefined)) {
      const attributes = { ...pending.entry.attributes, ...entry.attributes }
      if (previousContent !== undefined && content !== undefined) {
        attributes["message.content"] = `${previousContent}${content}`
      }
      pending.entry = { ...entry, attributes }
    }
    else {
      flushMessageDelta(key)
      pendingMessageDeltas.set(key, { entry, events: 0 })
    }
    const current = pendingMessageDeltas.get(key)
    if (!current) return
    current.events++
    const pendingContent = current.entry.attributes?.["message.content"]
    if (current.events >= messageDeltaChunkEvents
      || String(pendingContent ?? "").length >= messageDeltaChunkCharacters) {
      flushMessageDelta(key, false)
    }
  }
  return {
    append(entry: TraceEventLogEntry): void {
      const resultText = entry.attributes?.["result.text"]
      if (entry.name === "agent.invocation.finish" && hasRuntimeType(resultText, "string")) {
        entry.attributes = { ...entry.attributes, "result.text": redactCredentialText(resultText) }
      }
      if (entry.name === "agent.message.delta") {
        queueMessageDelta(entry)
      }
      else {
        const terminal = entry.name === "agent.invocation.finish"
          || entry.name === "agent.invocation.error"
          || entry.name === "agent.invocation.cancelled"
        flushMessageDeltas(terminal)
        if (terminal && messageDeltaKeysTruncated) {
          entry.attributes = { ...entry.attributes, "content.truncated": true }
        }
        emit(entry)
      }
    },
    // Reading the journal is not a stream boundary: keep possible credential suffixes.
    flush(): void {
      flushMessageDeltas(false)
    },
  }
}
