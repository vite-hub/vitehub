import { getSchema } from "@tiptap/core"
import { prosemirrorJSONToYXmlFragment, updateYFragment, yXmlFragmentToProsemirrorJSON } from "@tiptap/y-tiptap"
import * as Y from "yjs"

export { readRealtimeStatus, realtimeDocumentLayout } from "./layout.ts"

import type { Schema } from "@tiptap/pm/model"
import { realtimeDocumentLayout } from "./layout.ts"
import type { RealtimeDocumentSnapshot, RealtimeDocumentStatus, RealtimeEditor, RealtimeFieldValue } from "./types.ts"

const schemas = new WeakMap<RealtimeEditor, Schema>()

function realtimeEditorSchema(editor: RealtimeEditor): Schema {
  let schema = schemas.get(editor)
  if (!schema) {
    schema = getSchema(editor.extensions())
    schemas.set(editor, schema)
  }
  return schema
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  if (isRecord(value)) {
    const record = value
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`
  }
  return JSON.stringify(value ?? null)
}

export function realtimeJsonEqual(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right)
}

function writeFields(map: Y.Map<unknown>, fields: Record<string, RealtimeFieldValue> | undefined): void {
  const next = fields ?? {}
  for (const key of map.keys()) {
    if (!Object.hasOwn(next, key)) map.delete(key)
  }
  for (const [key, value] of Object.entries(next)) {
    if (value === undefined) continue
    if (!map.has(key) || !realtimeJsonEqual(map.get(key), value)) map.set(key, structuredClone(value))
  }
}

/** Builds a new room document from a stored snapshot. Only use it for rooms no client holds yet. */
export async function createRealtimeYDoc(editor: RealtimeEditor, snapshot: RealtimeDocumentSnapshot): Promise<Y.Doc> {
  const content = await editor.fromMarkdown(snapshot.body)
  const document = new Y.Doc()
  try {
    document.transact(() => {
      prosemirrorJSONToYXmlFragment(realtimeEditorSchema(editor), content, document.getXmlFragment(realtimeDocumentLayout.body))
      writeFields(document.getMap(realtimeDocumentLayout.fields), snapshot.fields)
    })
    return document
  }
  catch (error) {
    document.destroy()
    throw error
  }
}

function readRealtimeFields(document: Y.Doc): Record<string, RealtimeFieldValue> {
  // SAFETY: Fields hold only JSON values: the server writes RealtimeFieldValue and Y.Map.toJSON() returns JSON.
  return document.getMap(realtimeDocumentLayout.fields).toJSON() as Record<string, RealtimeFieldValue>
}

export async function readRealtimeYDoc(editor: RealtimeEditor, document: Y.Doc): Promise<Required<RealtimeDocumentSnapshot>> {
  const content = yXmlFragmentToProsemirrorJSON(document.getXmlFragment(realtimeDocumentLayout.body))
  return { body: await editor.toMarkdown(content), fields: readRealtimeFields(document) }
}

/** Whether `fromMarkdown(body)` gives back the body of `document`, where `body` is what `toMarkdown` wrote for it. */
export async function realtimeCodecReadsBack(editor: RealtimeEditor, document: Y.Doc, body: string): Promise<boolean> {
  const schema = realtimeEditorSchema(editor)
  try {
    const written = schema.nodeFromJSON(yXmlFragmentToProsemirrorJSON(document.getXmlFragment(realtimeDocumentLayout.body)))
    return written.eq(schema.nodeFromJSON(await editor.fromMarkdown(body)))
  }
  catch {
    return false
  }
}

/** Adds the final newline that a codec dropped when the stored body ends with one. */
export function keepRealtimeFinalNewline(body: string, finalNewline: boolean): string {
  return finalNewline && !body.endsWith("\n") ? `${body}\n` : body
}

function sameBody(left: string, right: string): boolean {
  return left === right || keepRealtimeFinalNewline(left, true) === keepRealtimeFinalNewline(right, true)
}

/**
 * Returns the Yjs update that turns `base` into `target` as a structural diff. Applying it to a
 * room that has moved on since `base` keeps concurrent edits instead of duplicating content.
 */
export async function diffRealtimeYDoc(editor: RealtimeEditor, base: Y.Doc, target: RealtimeDocumentSnapshot): Promise<Uint8Array> {
  const current = await readRealtimeYDoc(editor, base)
  const next = sameBody(target.body, current.body) ? undefined : await editor.fromMarkdown(target.body)
  // A stored form without `fields` leaves the live fields untouched.
  const fieldsChanged = target.fields !== undefined && !realtimeJsonEqual(current.fields, target.fields)
  if (!next && !fieldsChanged) return new Uint8Array()
  const clone = new Y.Doc({ gc: false })
  try {
    Y.applyUpdate(clone, Y.encodeStateAsUpdate(base))
    const state = Y.encodeStateVector(clone)
    clone.transact(() => {
      if (next) {
        updateYFragment(clone, clone.getXmlFragment(realtimeDocumentLayout.body), realtimeEditorSchema(editor).nodeFromJSON(next), {
          isOMark: new Map(),
          mapping: new Map(),
        })
      }
      if (fieldsChanged) writeFields(clone.getMap(realtimeDocumentLayout.fields), target.fields)
    })
    return Y.encodeStateAsUpdate(clone, state)
  }
  finally {
    clone.destroy()
  }
}

export function writeRealtimeStatus(document: Y.Doc, status: Partial<RealtimeDocumentStatus>, origin: unknown): void {
  const map = document.getMap<unknown>(realtimeDocumentLayout.status)
  document.transact(() => {
    for (const [key, value] of Object.entries(status)) {
      if (value === undefined) continue
      if (!map.has(key) || !realtimeJsonEqual(map.get(key), value)) map.set(key, value === null ? null : structuredClone(value))
    }
  }, origin)
}

/** Compact fingerprint used to reject client updates that touch the server-written status. */
export function realtimeStatusFingerprint(document: Y.Doc): string {
  return stableJson(document.getMap(realtimeDocumentLayout.status).toJSON())
}

/** Whether `document` already contains every insertion and deletion in `state`. */
export function containsRealtimeState(document: Y.Doc, state: Uint8Array): boolean {
  const candidate = new Y.Doc({ gc: false })
  try {
    Y.applyUpdate(candidate, Y.encodeStateAsUpdate(document))
    const before = Y.snapshot(candidate)
    Y.applyUpdate(candidate, state)
    if (candidate.store.pendingStructs || candidate.store.pendingDs) return false
    return Y.equalSnapshots(before, Y.snapshot(candidate))
  }
  finally {
    candidate.destroy()
  }
}
