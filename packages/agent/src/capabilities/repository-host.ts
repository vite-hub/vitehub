import { defineCapability, normalizeMode } from "../capability-runtime.ts"
import {
  assertString,
  createTool,
  jsonObjectSchema,
  requirePrimitive,
} from "./storage/shared.ts"

import type {
  AgentCapabilityContext,
  AgentCapabilityDefinition,
  AgentCapabilityMode,
  AgentToolPolicyContext,
  AgentToolPolicyDecision,
  AgentToolSet,
  MaybePromise,
} from "../types.ts"

export type RepositoryHostProvider = "github" | "gitlab" | "bitbucket" | (string & {})
export type RepositoryHostTargetKind = "repository" | "changeRequest" | "issue" | "comment"
export type RepositoryHostReadOperation = "repository" | "changeRequests" | "changeRequest" | "changeRequestFiles" | "issues" | "issue" | "comments" | "checks" | "statuses"
export type RepositoryHostWriteOperation = "comment" | "reaction"
export type RepositoryHostToolPolicy = AgentToolPolicyDecision | ((context: AgentToolPolicyContext) => MaybePromise<AgentToolPolicyDecision>)

export interface RepositoryHostTarget {
  host?: string
  id?: number | string
  kind?: RepositoryHostTargetKind
  owner?: string
  repository: string
}

export interface RepositoryHostReadRequest {
  operation: RepositoryHostReadOperation
  params?: Record<string, unknown>
  target: RepositoryHostTarget
}

export interface RepositoryHostWriteRequest {
  body?: string
  operation: RepositoryHostWriteOperation
  params?: Record<string, unknown>
  target: RepositoryHostTarget
}

export interface RepositoryHostClient {
  provider?: RepositoryHostProvider
  read: (request: RepositoryHostReadRequest) => MaybePromise<unknown>
  write?: (request: RepositoryHostWriteRequest) => MaybePromise<unknown>
}

export interface RepositoryHostOptions {
  client?: RepositoryHostClient | ((context: AgentCapabilityContext) => MaybePromise<RepositoryHostClient>)
  mode?: AgentCapabilityMode
  policy?: RepositoryHostToolPolicy
  provider?: RepositoryHostProvider
}

const readOperations = new Set<RepositoryHostReadOperation>(["repository", "changeRequests", "changeRequest", "changeRequestFiles", "issues", "issue", "comments", "checks", "statuses"])
const writeOperations = new Set<RepositoryHostWriteOperation>(["comment", "reaction"])

const repositoryHostTargetSchema = jsonObjectSchema({
  host: { description: "Provider host, such as github.com or a self-hosted GitLab domain.", type: "string" },
  id: { oneOf: [{ type: "string" }, { type: "number" }] },
  kind: { enum: ["repository", "changeRequest", "issue", "comment"], type: "string" },
  owner: { description: "Repository owner, organization, group, workspace, or project namespace.", type: "string" },
  repository: { description: "Repository name or provider-native repository path.", type: "string" },
}, ["repository"])

const repositoryHostReadInputSchema = jsonObjectSchema({
  operation: { enum: [...readOperations], type: "string" },
  params: { additionalProperties: true, type: "object" },
  target: repositoryHostTargetSchema,
}, ["operation", "target"])

const repositoryHostWriteInputSchema = jsonObjectSchema({
  body: { type: "string" },
  operation: { enum: [...writeOperations], type: "string" },
  params: { additionalProperties: true, type: "object" },
  target: repositoryHostTargetSchema,
}, ["operation", "target"])

async function resolveRepositoryHostClient(options: RepositoryHostOptions, context: AgentCapabilityContext): Promise<RepositoryHostClient> {
  const client = options.client
    ? typeof options.client === "function" ? await options.client(context) : options.client
    : requirePrimitive(context, "repository-host")
  if (!client || typeof client !== "object" || typeof (client as RepositoryHostClient).read !== "function") {
    throw new Error("[vitehub] repositoryHost() requires a Repository Host client with read().")
  }
  return client as RepositoryHostClient
}

function assertTarget(target: RepositoryHostTarget | undefined, operation: string): RepositoryHostTarget {
  if (!target || typeof target !== "object") throw new TypeError(`[vitehub] ${operation} target must be an object.`)
  assertString(target.repository, `${operation} target.repository`)
  if (target.id !== undefined && typeof target.id !== "string" && typeof target.id !== "number") {
    throw new TypeError(`[vitehub] ${operation} target.id must be a string or number.`)
  }
  return target
}

function assertReadRequest(input: RepositoryHostReadRequest): RepositoryHostReadRequest {
  if (!readOperations.has(input?.operation)) throw new Error(`[vitehub] Unsupported repository_host_read operation: ${String(input?.operation)}`)
  const target = assertTarget(input.target, "repository_host_read")
  if (!["repository", "changeRequests", "issues"].includes(input.operation) && target.id === undefined) {
    throw new TypeError(`[vitehub] repository_host_read ${input.operation} requires target.id.`)
  }
  return { ...input, target }
}

function assertWriteRequest(input: RepositoryHostWriteRequest): RepositoryHostWriteRequest {
  if (!writeOperations.has(input?.operation)) throw new Error(`[vitehub] Unsupported repository_host_write operation: ${String(input?.operation)}`)
  const target = assertTarget(input.target, "repository_host_write")
  if (target.id === undefined) throw new TypeError(`[vitehub] repository_host_write ${input.operation} requires target.id.`)
  if (input.operation === "comment") assertString(input.body, "repository_host_write comment body")
  return { ...input, target }
}

function repositoryHostTools(mode: AgentCapabilityMode, options: RepositoryHostOptions): AgentCapabilityDefinition["tools"] {
  return async (context) => {
    const client = await resolveRepositoryHostClient(options, context as never)
    const tools: AgentToolSet = {
      repository_host_read: createTool<RepositoryHostReadRequest>({
        description: "Read repository-hosted metadata for repositories, Change Requests, Change Request files, issues, comments, checks, or statuses.",
        execute: input => client.read(assertReadRequest(input)),
        inputSchema: repositoryHostReadInputSchema,
        name: "repository_host_read",
      }),
    }
    if (mode === "write") {
      tools.repository_host_write = createTool<RepositoryHostWriteRequest>({
        activity: { kind: "action", name: "repository-host.write" },
        description: "Create repository-hosted comments or reactions through the configured provider client.",
        execute(input) {
          if (!client.write) throw new Error("[vitehub] repository_host_write requires the Repository Host client to expose write().")
          return client.write(assertWriteRequest(input))
        },
        inputSchema: repositoryHostWriteInputSchema,
        name: "repository_host_write",
        policy: options.policy,
      })
    }
    return tools
  }
}

export function repositoryHost(options: RepositoryHostOptions = {}): AgentCapabilityDefinition {
  const mode = normalizeMode(options.mode, "Repository Host")
  return defineCapability({
    id: "repository-host",
    metadata: { kind: "repository-host", mode, ...(options.provider ? { provider: options.provider } : {}) },
    mode,
    requires: options.client ? undefined : [{ primitive: "repository-host" }],
    tools: repositoryHostTools(mode, options),
  })
}
