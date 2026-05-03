import type { ChatCloudflareDurableObjectModuleOptions } from "../types.ts"

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
