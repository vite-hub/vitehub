import { readFile } from "node:fs/promises"

import { defaultChatCloudflareDurableObjectState } from "../config.ts"

import type { ChatCloudflareDurableObjectModuleOptions } from "../types.ts"
import type { DiscoveredChatDefinition } from "../types.ts"

interface MutableCloudflareTarget {
  cloudflare?: {
    wrangler?: {
      durable_objects?: {
        bindings?: Array<{ class_name: string, name: string }>
      }
      migrations?: Array<{ new_sqlite_classes?: string[], tag: string }>
    }
  }
}

export function configureCloudflareChatState(
  target: MutableCloudflareTarget,
  options: Required<Pick<ChatCloudflareDurableObjectModuleOptions, "binding" | "className" | "migrationTag">>,
): void {
  target.cloudflare ||= {}
  target.cloudflare.wrangler ||= {}
  target.cloudflare.wrangler.durable_objects ||= {}
  target.cloudflare.wrangler.durable_objects.bindings ||= []
  target.cloudflare.wrangler.migrations ||= []

  const bindings = target.cloudflare.wrangler.durable_objects.bindings
  if (!bindings.some(binding => binding.name === options.binding)) {
    bindings.push({
      class_name: options.className,
      name: options.binding,
    })
  }

  const migrations = target.cloudflare.wrangler.migrations
  const existingWithClass = migrations.find(migration => migration.new_sqlite_classes?.includes(options.className))
  if (existingWithClass) {
    return
  }

  const migration = migrations.find(entry => entry.tag === options.migrationTag)
  if (migration) {
    migration.new_sqlite_classes ||= []
    if (!migration.new_sqlite_classes.includes(options.className)) {
      migration.new_sqlite_classes.push(options.className)
    }
    return
  }

  migrations.push({
    new_sqlite_classes: [options.className],
    tag: options.migrationTag,
  })
}

const cloudflareDurableObjectStateCall = "cloudflareDurableObjectState"

function readStringOption(source: string, key: "binding" | "className" | "migrationTag"): string | undefined {
  const match = new RegExp(`\\b${key}\\s*:\\s*["']([^"']+)["']`).exec(source)
  return match?.[1]
}

export async function discoverCloudflareChatStateConfig(
  definitions: DiscoveredChatDefinition[],
): Promise<Array<Required<Pick<ChatCloudflareDurableObjectModuleOptions, "binding" | "className" | "migrationTag">>>> {
  const configs = new Map<string, Required<Pick<ChatCloudflareDurableObjectModuleOptions, "binding" | "className" | "migrationTag">>>()

  for (const definition of definitions) {
    const contents = await readFile(definition.handler, "utf8")
    const index = contents.indexOf(cloudflareDurableObjectStateCall)
    if (index === -1) {
      continue
    }

    const callContents = contents.slice(index, index + 1200)
    const config = {
      binding: readStringOption(callContents, "binding") || defaultChatCloudflareDurableObjectState.binding,
      className: readStringOption(callContents, "className") || defaultChatCloudflareDurableObjectState.className,
      migrationTag: readStringOption(callContents, "migrationTag") || defaultChatCloudflareDurableObjectState.migrationTag,
    }
    configs.set(config.binding, config)
  }

  return [...configs.values()]
}
