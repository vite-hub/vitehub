import { defineTool } from "@vitehub/agent"

import type { AgentToolDefinition, AgentToolSet } from "@vitehub/agent"

export type BlobAgentToolAccess = "read" | "write"

export type BlobAgentToolDefinition<TInput = unknown, TOutput = unknown> = AgentToolDefinition<TInput, TOutput>
export type BlobAgentToolSet = AgentToolSet

export interface BlobAgentStorage {
  del(pathname: string): Promise<void>
  get(pathname: string): Promise<Blob | null>
  head(pathname: string): Promise<unknown>
  list(options?: unknown): Promise<unknown>
  put(pathname: string, body: string, options?: unknown): Promise<unknown>
}

export interface CreateBlobToolsOptions {
  access?: BlobAgentToolAccess
  blob?: BlobAgentStorage
}

interface PathInput {
  pathname: string
}

interface ListInput {
  cursor?: string
  folded?: boolean
  limit?: number
  prefix?: string
}

interface PutTextInput extends PathInput {
  content: string
  contentType?: string
  customMetadata?: Record<string, string>
  prefix?: string
}

interface PutJsonInput extends PathInput {
  content: unknown
  customMetadata?: Record<string, string>
  prefix?: string
}

const metadata = {
  category: "blob",
  preset: "vitehub-blob",
}

async function getBlob(options: CreateBlobToolsOptions) {
  if (options.blob) return options.blob
  const module = await import("./index.ts")
  return module.blob
}

function pathnameProperty() {
  return {
    pathname: { description: "Blob object pathname.", type: "string" },
  }
}

function putOptionsProperties() {
  return {
    customMetadata: {
      additionalProperties: { type: "string" },
      description: "Optional string metadata to store with the object.",
      type: "object",
    },
    prefix: { description: "Optional driver-specific path prefix.", type: "string" },
  }
}

function readTools(options: CreateBlobToolsOptions): BlobAgentToolSet {
  return {
    blob_list: defineTool<ListInput, unknown>({
      description: "List blob objects.",
      execute: async input => await (await getBlob(options)).list(input),
      inputSchema: {
        additionalProperties: false,
        properties: {
          cursor: { description: "Pagination cursor from a previous list result.", type: "string" },
          folded: { description: "Group results by folder-like prefixes when supported.", type: "boolean" },
          limit: { description: "Maximum number of objects to return.", maximum: 100, minimum: 1, type: "number" },
          prefix: { description: "Only list objects whose pathname starts with this prefix.", type: "string" },
        },
        type: "object",
      },
      metadata,
      name: "blob_list",
    }),
    blob_head: defineTool<PathInput, unknown>({
      description: "Read metadata for one blob object.",
      execute: async ({ pathname }) => await (await getBlob(options)).head(pathname),
      inputSchema: {
        additionalProperties: false,
        properties: pathnameProperty(),
        required: ["pathname"],
        type: "object",
      },
      metadata,
      name: "blob_head",
    }),
    blob_get_text: defineTool<PathInput, { content: string | null, pathname: string }>({
      description: "Read one blob object as text.",
      execute: async ({ pathname }) => {
        const value = await (await getBlob(options)).get(pathname)
        return { content: value ? await value.text() : null, pathname }
      },
      inputSchema: {
        additionalProperties: false,
        properties: pathnameProperty(),
        required: ["pathname"],
        type: "object",
      },
      metadata,
      name: "blob_get_text",
    }),
  }
}

function writeTools(options: CreateBlobToolsOptions): BlobAgentToolSet {
  return {
    blob_put_text: defineTool<PutTextInput, unknown>({
      description: "Write text content to one blob object.",
      execute: async ({ content, contentType = "text/plain; charset=utf-8", customMetadata, pathname, prefix }) => {
        return await (await getBlob(options)).put(pathname, content, { contentType, customMetadata, prefix })
      },
      inputSchema: {
        additionalProperties: false,
        properties: {
          ...pathnameProperty(),
          ...putOptionsProperties(),
          content: { description: "Text content to store.", type: "string" },
          contentType: { description: "MIME content type for the stored text.", type: "string" },
        },
        required: ["pathname", "content"],
        type: "object",
      },
      metadata,
      name: "blob_put_text",
    }),
    blob_put_json: defineTool<PutJsonInput, unknown>({
      description: "Write JSON content to one blob object.",
      execute: async ({ content, customMetadata, pathname, prefix }) => {
        return await (await getBlob(options)).put(pathname, JSON.stringify(content), {
          contentType: "application/json; charset=utf-8",
          customMetadata,
          prefix,
        })
      },
      inputSchema: {
        additionalProperties: false,
        properties: {
          ...pathnameProperty(),
          ...putOptionsProperties(),
          content: { description: "JSON-serializable content to store." },
        },
        required: ["pathname", "content"],
        type: "object",
      },
      metadata,
      name: "blob_put_json",
    }),
    blob_delete: defineTool<PathInput, { pathname: string }>({
      description: "Delete one blob object.",
      execute: async ({ pathname }) => {
        await (await getBlob(options)).del(pathname)
        return { pathname }
      },
      inputSchema: {
        additionalProperties: false,
        properties: pathnameProperty(),
        required: ["pathname"],
        type: "object",
      },
      metadata,
      name: "blob_delete",
    }),
  }
}

export function createBlobTools(options: CreateBlobToolsOptions = {}): BlobAgentToolSet {
  const access = options.access || "read"
  if (access === "read") return readTools(options)
  if (access === "write") return { ...readTools(options), ...writeTools(options) }
  throw new TypeError(`[vitehub] Unknown Blob agent tool access: ${String(access)}`)
}
