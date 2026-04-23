import type { Nitro } from 'nitro/types'
import type {
  MutableCloudflareTarget,
  WranglerAnalyticsEngineDataset,
  MutableWranglerConfig,
  WranglerContainer,
  WranglerDurableObjectBinding,
  WranglerKVNamespace,
  WranglerMigration,
  WranglerWorkerLoader,
  WranglerWorkflow,
} from './nitro-target'

type NitroWithCloudflareWranglerFinalizer = Nitro & {
  __vitehubCloudflareWranglerFinalizerInstalled?: boolean
}

function compareNumericStrings(left: string, right: string) {
  return left.localeCompare(right, undefined, { numeric: true })
}

function compareMigrationTags(left: WranglerMigration, right: WranglerMigration) {
  return compareNumericStrings(left.tag, right.tag)
}

function isSameKVNamespace(left: WranglerKVNamespace, right: WranglerKVNamespace) {
  return left.binding === right.binding
    && left.id === right.id
    && left.preview_id === right.preview_id
    && left.experimental_remote === right.experimental_remote
}

function isSameContainer(left: WranglerContainer, right: WranglerContainer) {
  return left.class_name === right.class_name
    && left.image === right.image
    && left.instance_type === right.instance_type
    && left.max_instances === right.max_instances
}

function isSameDurableObjectBinding(left: WranglerDurableObjectBinding, right: WranglerDurableObjectBinding) {
  return left.name === right.name
    && left.class_name === right.class_name
}

function isSameWorkerLoader(left: WranglerWorkerLoader, right: WranglerWorkerLoader) {
  return left.binding === right.binding
}

function isSameAnalyticsEngineDataset(left: WranglerAnalyticsEngineDataset, right: WranglerAnalyticsEngineDataset) {
  return left.binding === right.binding
    && left.dataset === right.dataset
}

function isSameWorkflow(left: WranglerWorkflow, right: WranglerWorkflow) {
  return left.binding === right.binding
    && left.name === right.name
    && left.class_name === right.class_name
}

function dedupeByKey<T>(
  entries: T[] | undefined,
  getKey: (entry: T) => string,
  equals: (left: T, right: T) => boolean,
  conflictLabel: string,
) {
  if (!entries?.length)
    return undefined

  const unique = new Map<string, T>()
  for (const entry of entries) {
    const key = getKey(entry)
    const existing = unique.get(key)
    if (!existing) {
      unique.set(key, entry)
      continue
    }

    if (!equals(existing, entry)) {
      throw new Error(`[vitehub] Conflicting Cloudflare ${conflictLabel} "${key}".`)
    }
  }

  return [...unique.values()]
}

function mergeMigrations(migrations: WranglerMigration[] | undefined) {
  if (!migrations?.length)
    return undefined

  const byTag = new Map<string, Set<string>>()

  for (const migration of migrations) {
    const classes = byTag.get(migration.tag) || new Set<string>()
    for (const className of migration.new_sqlite_classes || [])
      classes.add(className)
    byTag.set(migration.tag, classes)
  }

  return [...byTag.entries()]
    .map(([tag, classes]) => ({
      tag,
      ...(classes.size ? { new_sqlite_classes: [...classes].sort(compareNumericStrings) } : {}),
    } satisfies WranglerMigration))
    .sort(compareMigrationTags)
}

function validateDurableObjectMigrations(wrangler: MutableWranglerConfig) {
  const bindings = wrangler.durable_objects?.bindings
  if (!bindings?.length)
    return

  const declaredClasses = new Set(
    (wrangler.migrations || [])
      .flatMap(migration => migration.new_sqlite_classes || []),
  )
  const missingClasses = [...new Set(bindings.map(binding => binding.class_name))]
    .filter(className => !declaredClasses.has(className))
    .sort(compareNumericStrings)

  if (missingClasses.length) {
    throw new Error(
      `[vitehub] Missing Cloudflare durable object migration entries for: ${missingClasses.join(', ')}.`,
    )
  }
}

export function finalizeCloudflareWranglerConfig(target: MutableCloudflareTarget) {
  const wrangler = target.cloudflare?.wrangler
  if (!wrangler)
    return

  wrangler.kv_namespaces = dedupeByKey(
    wrangler.kv_namespaces,
    namespace => namespace.binding,
    isSameKVNamespace,
    'KV namespace binding',
  )?.sort((left, right) => compareNumericStrings(left.binding, right.binding))

  wrangler.containers = dedupeByKey(
    wrangler.containers,
    container => container.class_name,
    isSameContainer,
    'container',
  )?.sort((left, right) => compareNumericStrings(left.class_name, right.class_name))

  wrangler.worker_loaders = dedupeByKey(
    wrangler.worker_loaders,
    loader => loader.binding,
    isSameWorkerLoader,
    'worker loader binding',
  )?.sort((left, right) => compareNumericStrings(left.binding, right.binding))

  wrangler.analytics_engine_datasets = dedupeByKey(
    wrangler.analytics_engine_datasets,
    dataset => dataset.binding,
    isSameAnalyticsEngineDataset,
    'analytics engine dataset binding',
  )?.sort((left, right) => compareNumericStrings(left.binding, right.binding))

  wrangler.durable_objects ||= {}
  wrangler.durable_objects.bindings = dedupeByKey(
    wrangler.durable_objects.bindings,
    binding => binding.name,
    isSameDurableObjectBinding,
    'durable object binding',
  )?.sort((left, right) => compareNumericStrings(left.name, right.name))

  wrangler.workflows = dedupeByKey(
    wrangler.workflows,
    workflow => workflow.binding,
    isSameWorkflow,
    'workflow binding',
  )?.sort((left, right) => compareNumericStrings(left.binding, right.binding))

  wrangler.migrations = mergeMigrations(wrangler.migrations)
  validateDurableObjectMigrations(wrangler)
}

export function installCloudflareWranglerFinalizer(nitro: Nitro) {
  const target = nitro as NitroWithCloudflareWranglerFinalizer
  if (target.__vitehubCloudflareWranglerFinalizerInstalled)
    return

  target.__vitehubCloudflareWranglerFinalizerInstalled = true
  nitro.hooks.hook('build:before', () => {
    finalizeCloudflareWranglerConfig(nitro.options as MutableCloudflareTarget)
  })
}
