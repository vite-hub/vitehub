import { Node } from "@tiptap/core"
import { vi } from "vitest"
import * as decoding from "lib0/decoding"
import * as encoding from "lib0/encoding"
import * as awarenessProtocol from "y-protocols/awareness"
import * as syncProtocol from "y-protocols/sync"
import * as Y from "yjs"

import type { JSONContent } from "@tiptap/core"
import type { RealtimeBus, RealtimeBusMessage, RealtimeRoomRecord } from "../src/bus-protocol.ts"
import type { RealtimeControlMessage } from "../src/protocol.ts"
import type { RealtimeHandlerOptions } from "../src/server.ts"
import type { RealtimeDefinition, RealtimeDocumentAdapter, RealtimeFieldValue, RealtimeIssue } from "../src/types.ts"
import { RealtimeDocumentConflict } from "../src/conflict.ts"
import { defineRealtimeEditor } from "../src/editor.ts"
import { decodeRealtimeControlPayload, messageAwareness, messageRealtimeControl } from "../src/protocol.ts"
import { createRealtimeHandler, encodeSyncStep1, encodeSyncUpdate } from "../src/server.ts"

const messageSync = 0

/** Lets queued promise continuations run without advancing fake timers. */
export async function settle(rounds = 50): Promise<void> {
  for (let index = 0; index < rounds; index++) await Promise.resolve()
}

/** Plain-paragraph schema with an async codec: Markdown paragraphs separated by blank lines. */
export function createStubEditor() {
  const calls = { fromMarkdown: 0, toMarkdown: 0 }
  const editor = defineRealtimeEditor({
    extensions: () => [
      Node.create({ name: "doc", topNode: true, content: "paragraph+" }),
      Node.create({ name: "paragraph", group: "block", content: "text*" }),
      Node.create({ name: "text", group: "inline" }),
    ],
    async fromMarkdown(markdown) {
      calls.fromMarkdown++
      await new Promise<void>(resolve => queueMicrotask(resolve))
      const paragraphs = markdown ? markdown.split("\n\n") : [""]
      return {
        type: "doc",
        content: paragraphs.map(text => text ? { type: "paragraph", content: [{ type: "text", text }] } : { type: "paragraph" }),
      }
    },
    async toMarkdown(document: JSONContent) {
      calls.toMarkdown++
      await new Promise<void>(resolve => queueMicrotask(resolve))
      return (document.content ?? []).map(paragraph => (paragraph.content ?? []).map(node => node.text ?? "").join("")).join("\n\n")
    },
  })
  return { calls, editor }
}

interface StoredDocument {
  body: string
  digest: string
  fields?: Record<string, RealtimeFieldValue>
}

/** In-memory document adapter with compare-and-set saves. */
export function createMemoryAdapter(initial: Record<string, Omit<StoredDocument, "digest">> = {}, options: {
  issues?: (document: { body: string, fields?: Record<string, RealtimeFieldValue> }) => RealtimeIssue[]
  normalize?: (document: { body: string, fields?: Record<string, RealtimeFieldValue> }) => { body: string, fields?: Record<string, RealtimeFieldValue> }
} = {}) {
  let version = 1
  const store = new Map<string, StoredDocument>(Object.entries(initial).map(([id, value]) => [id, { ...value, digest: "v1" }]))
  const adapter = {
    kind: "memory-test",
    load: async ({ documentId }: { documentId: string }) => {
      const current = store.get(documentId)
      return current ? { body: current.body, digest: current.digest, fields: current.fields } : { body: "", digest: null }
    },
    save: async ({ documentId }: { documentId: string }, document: { body: string, fields?: Record<string, RealtimeFieldValue> }, saveOptions: { ifDigest: string | null }) => {
      if ((store.get(documentId)?.digest ?? null) !== saveOptions.ifDigest) throw new RealtimeDocumentConflict()
      const stored = options.normalize ? options.normalize(document) : document
      const digest = `v${++version}`
      store.set(documentId, { ...stored, digest })
      return { digest, issues: options.issues?.(document), stored: options.normalize ? stored : undefined }
    },
  }
  const spies = {
    load: vi.fn(adapter.load),
    save: vi.fn(adapter.save),
  }
  return {
    adapter: { kind: adapter.kind, load: spies.load, save: spies.save } as RealtimeDocumentAdapter & typeof spies,
    store,
    write(documentId: string, body: string, fields?: Record<string, RealtimeFieldValue>) {
      store.set(documentId, { body, digest: `external-${++version}`, fields })
    },
  }
}

export function registryOf(definition: RealtimeDefinition) {
  return { docs: async () => ({ default: definition }) }
}

type Hooks = {
  close(peer: object): void
  message(peer: object, message: { uint8Array(): Uint8Array }): void
  open(peer: object): void
  upgrade?(request: Request): Response | void | Promise<Response | void>
}

export interface TestClient {
  awareness: Uint8Array[]
  close(): void
  closed?: { code: number, reason: string }
  controls: RealtimeControlMessage[]
  doc: Y.Doc
  peer: object
  response: Response
}

/** Drives the Realtime handler through its WebSocket hooks the way y-websocket clients do. */
export function createTestServer(definition: RealtimeDefinition, options: { durable?: FakeSql, handler?: RealtimeHandlerOptions } = {}) {
  const handler = createRealtimeHandler(registryOf(definition) as never, options.handler)
  const channels = new Map<string, Set<{ send(data: Uint8Array): void }>>()

  function request(path: string, init: RequestInit & { query?: Record<string, string> } = {}) {
    const url = new URL(`https://example.com/api/_vitehub/realtime/docs/${path}`)
    for (const [key, value] of Object.entries(init.query ?? {})) url.searchParams.set(key, value)
    const value = new Request(url, init) as Request & { runtime?: unknown }
    if (options.durable) value.runtime = { cloudflare: { env: {}, context: { storage: { sql: options.durable.carrier } } } }
    return value
  }

  async function connect(path: string, init: { doc?: Y.Doc, editor?: string, epoch?: string, headers?: Record<string, string>, clientId?: boolean } = {}): Promise<TestClient> {
    const doc = init.doc ?? new Y.Doc()
    const response = await handler.fetch(request(path, {
      headers: { upgrade: "websocket", ...init.headers },
      query: { ...init.epoch ? { epoch: init.epoch } : {}, ...init.editor === undefined ? {} : { editor: init.editor }, ...init.clientId ? { clientId: String(doc.clientID) } : {} },
    })) as Response & { crossws?: Hooks }
    const client: TestClient = {
      awareness: [],
      close: () => {
        if (client.closed) return
        client.closed = { code: 1000, reason: "client closed" }
        unsubscribeAll()
        response.crossws?.close(peer)
      },
      controls: [],
      doc,
      peer: undefined as never,
      response,
    }
    // crossws calls `upgrade` first; a Response refuses the socket with its status.
    const refusal = await response.crossws?.upgrade?.(new Request("https://example.com", { headers: { upgrade: "websocket" } }))
    if (!response.crossws || refusal instanceof Response) {
      client.closed = { code: refusal instanceof Response ? refusal.status : response.status, reason: "rejected" }
      return client
    }
    const hooks = response.crossws
    const subscriptions = new Set<string>()
    const unsubscribeAll = () => {
      for (const channel of subscriptions) channels.get(channel)?.delete(peer)
      subscriptions.clear()
    }
    const send = (data: Uint8Array) => {
      if (!client.closed) hooks.message(peer, { uint8Array: () => data })
    }
    const peer = {
      close(code: number, reason: string) {
        if (client.closed) return
        client.closed = { code, reason }
        unsubscribeAll()
        hooks.close(peer)
      },
      publish(channel: string, data: Uint8Array) {
        for (const other of channels.get(channel) ?? []) {
          if (other !== peer) other.send(data)
        }
      },
      send(data: Uint8Array) {
        if (client.closed) return
        const decoder = decoding.createDecoder(data)
        const type = decoding.readVarUint(decoder)
        if (type === messageSync) {
          const encoder = encoding.createEncoder()
          encoding.writeVarUint(encoder, messageSync)
          syncProtocol.readSyncMessage(decoder, encoder, doc, "server")
          if (encoding.length(encoder) > 1) send(encoding.toUint8Array(encoder))
        }
        else if (type === messageRealtimeControl) {
          const control = decodeRealtimeControlPayload(decoder)
          if (control) client.controls.push(control)
        }
        else if (type === messageAwareness) {
          client.awareness.push(decoding.readVarUint8Array(decoder))
        }
      },
      subscribe(channel: string) {
        subscriptions.add(channel)
        let set = channels.get(channel)
        if (!set) channels.set(channel, set = new Set())
        set.add(peer)
      },
      unsubscribe(channel: string) {
        subscriptions.delete(channel)
        channels.get(channel)?.delete(peer)
      },
    }
    client.peer = peer
    doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin !== "server") send(encodeSyncUpdate(update))
    })
    hooks.open(peer)
    send(encodeSyncStep1(doc))
    return client
  }

  async function post(path: string, action: "checkpoint" | "refresh" | "save", init: { headers?: Record<string, string>, state?: Uint8Array } = {}) {
    return await handler.fetch(request(path, {
      body: init.state ? Uint8Array.from(init.state).buffer : undefined,
      headers: init.headers,
      method: "POST",
      query: action === "checkpoint" ? { history: "checkpoint" } : { document: action },
    }))
  }

  return { connect, handler, post }
}

export function sendAwareness(client: TestClient, state: Record<string, unknown>): void {
  const awareness = new awarenessProtocol.Awareness(client.doc)
  awareness.setLocalState(state)
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, messageAwareness)
  encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(awareness, [client.doc.clientID]))
  awareness.destroy()
  const hooks = (client.response as Response & { crossws: Hooks }).crossws
  hooks.message(client.peer, { uint8Array: () => encoding.toUint8Array(encoder) })
}

export function appendParagraph(doc: Y.Doc, text: string): void {
  const paragraph = new Y.XmlElement("paragraph")
  paragraph.insert(0, [new Y.XmlText(text)])
  doc.getXmlFragment("body").push([paragraph])
}

export function paragraphs(doc: Y.Doc): string[] {
  return doc.getXmlFragment("body").toArray().map(node => (node as Y.XmlElement).toArray().map(child => (child as Y.XmlText).toString()).join(""))
}

/** A carrier with the shape and receiver brand of workerd's native SqlStorage, which Cloudflare storage requires since #2410. */
export function nativeSqlCarrier(exec: (query: string, ...bindings: unknown[]) => { toArray(): Array<Record<string, unknown>> }) {
  function SqlStorage() {}
  const sql = Object.create(null) as Record<string, unknown>
  const prototype = {
    // Use a native constructor in the carrier shape. The production detector
    // treats the constructor as part of the platform object contract.
    constructor: SqlStorage,
    exec,
    get databaseSize() {
      return 1
    },
  }
  SqlStorage.prototype = prototype
  Object.setPrototypeOf(sql, prototype)
  Object.defineProperty(prototype, "databaseSize", {
    configurable: true,
    get: new Proxy(Object.getOwnPropertyDescriptor(Map.prototype, "size")!.get!, {
      apply(_target, thisArg) {
        if (thisArg === sql) return 1
        throw new TypeError("Illegal invocation")
      },
    }),
  })
  return sql
}

/** Minimal Durable Object SQLite surface for the statements the Realtime room issues. */
export class FakeSql {
  documents = new Map<string, Record<string, unknown>>()
  updates: Array<{ room_key: string, sequence: number, update_blob: ArrayBuffer, client_update?: number }> = []
  readonly intermediateJournal: boolean
  alterJournalAttempted = false
  private sequence = 0

  constructor(options: { intermediateJournal?: boolean } = {}) {
    this.intermediateJournal = options.intermediateJournal ?? false
  }

  /** The native SqlStorage carrier of this database, the `storage.sql` that a Durable Object request carries. */
  get carrier(): Record<string, unknown> {
    this.nativeCarrier ??= nativeSqlCarrier(this.exec)
    return this.nativeCarrier
  }

  private nativeCarrier: Record<string, unknown> | undefined

  exec = vi.fn((query: string, ...bindings: unknown[]) => {
    const rows = (value: Array<Record<string, unknown>>) => ({ toArray: () => value })
    if (query.startsWith("CREATE TABLE")) return rows([])
    if (query.startsWith("ALTER TABLE vitehub_realtime_document_updates ADD COLUMN client_update")) {
      this.alterJournalAttempted = true
      if (!this.intermediateJournal) throw new Error("duplicate column name: client_update")
      return rows([])
    }
    if (query.startsWith("ALTER TABLE vitehub_realtime_documents ADD COLUMN editor_version")) {
      throw new Error("duplicate column name: editor_version")
    }
    if (query.startsWith("SELECT client_update FROM vitehub_realtime_document_updates LIMIT 0")) {
      if (this.intermediateJournal) throw new Error("no such column: client_update")
      return rows([])
    }
    if (query.startsWith("SELECT room_key FROM vitehub_realtime_documents")) {
      const row = this.documents.get(String(bindings[0]))
      return rows(row ? [{ room_key: bindings[0] }] : [])
    }
    if (query.startsWith("SELECT epoch, digest, dirty, update_blob FROM vitehub_realtime_documents") || query.startsWith("SELECT epoch, digest, dirty, update_blob, editor_version FROM vitehub_realtime_documents")) {
      const row = this.documents.get(String(bindings[0]))
      return rows(row ? [row] : [])
    }
    if (query.startsWith("SELECT update_blob FROM vitehub_realtime_document_updates")) {
      return rows(this.updates.filter(row => row.room_key === bindings[0]).sort((a, b) => a.sequence - b.sequence))
    }
    if (query.startsWith("SELECT update_blob, client_update FROM vitehub_realtime_document_updates")) {
      return rows(this.updates.filter(row => row.room_key === bindings[0]).sort((a, b) => a.sequence - b.sequence))
    }
    if (query.startsWith("INSERT OR REPLACE INTO vitehub_realtime_documents")) {
      const [room_key, epoch, digest, dirty, update_blob, editor_version] = bindings
      this.documents.set(String(room_key), { digest, dirty, editor_version, epoch, update_blob })
      return rows([])
    }
    if (query.startsWith("DELETE FROM vitehub_realtime_document_updates")) {
      this.updates = this.updates.filter(row => row.room_key !== bindings[0])
      return rows([])
    }
    if (query.startsWith("INSERT INTO vitehub_realtime_document_updates")) {
      if (this.intermediateJournal && query.includes("client_update")) {
        throw new Error("table vitehub_realtime_document_updates has no column named client_update")
      }
      this.updates.push({ room_key: String(bindings[0]), sequence: ++this.sequence, update_blob: bindings[1] as ArrayBuffer, client_update: Number(bindings[2] ?? 1) })
      return rows([])
    }
    throw new Error(`Unexpected SQL: ${query}`)
  })
}

export interface MemoryBus extends RealtimeBus {
  /** Leaves the network without the goodbye that `close()` sends, as a process that crashed. */
  crash(): void
  published: RealtimeBusMessage[]
}

/**
 * Buses of several instances in one process, with one shared room store. Messages arrive asynchronously and in order,
 * and never at the sender, as with Postgres and Redis.
 */
export function createMemoryBusNetwork() {
  const records = new Map<string, RealtimeRoomRecord>()
  /** Every record write, in order. */
  const writes: Array<{ room: string, epoch: string, digest: string | null }> = []
  const locks = new Map<string, Promise<void>>()
  const members = new Map<string, (message: RealtimeBusMessage) => void>()

  function bus(authority: "postgres" | "redis" = "postgres"): MemoryBus {
    const instance = crypto.randomUUID()
    const hooks: Array<() => Promise<void>> = []
    const listeners = new Set<(message: RealtimeBusMessage) => void | Promise<void>>()
    let queue = Promise.resolve()
    let stopped = false
    const self: MemoryBus = {
      authority,
      instance,
      published: [],
      async publish(message) {
        if (stopped) return
        const sent = { ...message, instance, data: Uint8Array.from(message.data) }
        self.published.push(sent)
        for (const [member, deliver] of members) {
          if (member !== instance) deliver(sent)
        }
      },
      async subscribe(listener) {
        listeners.add(listener)
        members.set(instance, (message) => {
          queue = queue.then(async () => {
            for (const next of listeners) await next(message)
          })
        })
      },
      async readRoom(room) {
        const record = records.get(room)
        return record && { ...record, state: Uint8Array.from(record.state) }
      },
      async writeRoom(room, record, ifEpoch) {
        if ((records.get(room)?.epoch ?? null) !== ifEpoch) return false
        records.set(room, { ...record, state: Uint8Array.from(record.state) })
        writes.push({ room, epoch: record.epoch, digest: record.digest })
        return true
      },
      async withRoomLock(room, task) {
        const previous = locks.get(room) ?? Promise.resolve()
        let release = () => {}
        const held = new Promise<void>((resolve) => {
          release = resolve
        })
        locks.set(room, previous.then(() => held))
        await previous
        try {
          return await task()
        }
        finally {
          release()
        }
      },
      onClose(hook) {
        hooks.push(hook)
      },
      async close() {
        for (const hook of hooks) await hook()
        stopped = true
        members.delete(instance)
      },
      crash() {
        stopped = true
        members.delete(instance)
      },
    }
    return self
  }

  return { bus, records, writes }
}

/** One y-websocket style awareness for a test client, which sends its own state changes to the server. */
export function createClientAwareness(client: TestClient) {
  const awareness = new awarenessProtocol.Awareness(client.doc)
  const hooks = (client.response as Response & { crossws: Hooks }).crossws
  return {
    awareness,
    set(state: Record<string, unknown> | null) {
      awareness.setLocalState(state)
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, messageAwareness)
      encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(awareness, [client.doc.clientID]))
      hooks.message(client.peer, { uint8Array: () => encoding.toUint8Array(encoder) })
    },
  }
}

/** The presence that a test client sees: every awareness update it received, applied in order. */
export function presence(client: TestClient): Map<number, Record<string, unknown>> {
  const awareness = new awarenessProtocol.Awareness(new Y.Doc())
  awareness.setLocalState(null)
  try {
    for (const update of client.awareness) awarenessProtocol.applyAwarenessUpdate(awareness, update, "test")
    // SAFETY: test clients only send plain object states.
    return new Map(awareness.getStates() as Map<number, Record<string, unknown>>)
  }
  finally {
    awareness.destroy()
    awareness.doc.destroy()
  }
}
