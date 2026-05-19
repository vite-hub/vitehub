import type { WorkflowModuleOptions } from "@vitehub/workflow"
import type { ChatModuleOptions, ChatWebhookModuleOptions } from "./types.ts"

export interface NodeDockerRuntimePresetOptions {
  chat?: ChatModuleOptions
  preset?: string
  workflow?: Exclude<WorkflowModuleOptions, false>
}

export interface NodeDockerRuntimePreset {
  chat: ChatModuleOptions
  preset: string
  workflow: Exclude<WorkflowModuleOptions, false>
}

function mergeWebhookOptions(webhook: ChatModuleOptions["webhook"]): ChatModuleOptions["webhook"] {
  if (webhook === false || typeof webhook === "string") {
    return webhook
  }

  return {
    ...webhook,
    processing: webhook?.processing || "inline",
  } satisfies ChatWebhookModuleOptions
}

export function nodeDockerRuntimePreset(options: NodeDockerRuntimePresetOptions = {}): NodeDockerRuntimePreset {
  const chat = options.chat || {}
  const workflow = options.workflow || {}

  return {
    chat: {
      ...chat,
      provider: "nitro",
      webhook: mergeWebhookOptions(chat.webhook),
    },
    preset: options.preset || "node-server",
    workflow: {
      ...workflow,
      provider: "openworkflow",
    },
  }
}
