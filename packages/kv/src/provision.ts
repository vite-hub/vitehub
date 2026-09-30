import {
  createCloudflareProvisionClient,
  ProvisionRequestError,
  resolveCloudflareProvisionConfig,
} from "@vite-hub/internal/provision"

import { KV_CLOUDFLARE_PROVISION_CATEGORY } from "./integrations/cloudflare.ts"
import { resolveKVViteConfig } from "./vite-config.ts"

import type { CloudflareProvisionRequest, ProvisionAction, ProvisionStep } from "@vite-hub/internal/provision"
import type { KVModuleOptions } from "./types.ts"
import { kvErrorDiagnostics } from "./error-diagnostics.ts"

interface CloudflareKVNamespace {
  id?: string
  title?: string
}

const CLOUDFLARE_KV_NAMESPACE_LIST_PER_PAGE = 100
// Cloudflare rejects a duplicate namespace title with this error code.
const CLOUDFLARE_KV_DUPLICATE_TITLE_CODE = 10014

function parseNamespaces(value: unknown): CloudflareKVNamespace[] {
  if (!Array.isArray(value)) throw kvErrorDiagnostics.KV_R0019({ message: "Cloudflare provisioning returned an invalid KV namespace list." })
  // SAFETY: Namespace fields are optional and consumers narrow id and title before use.
  return value as CloudflareKVNamespace[]
}

function parseNamespace(value: unknown): CloudflareKVNamespace {
  if (!value || Object(value) !== value) throw kvErrorDiagnostics.KV_R0020({ message: "Cloudflare provisioning returned an invalid KV namespace." })
  return value
}

async function listNamespaceIds(request: CloudflareProvisionRequest): Promise<Map<string, string>> {
  const ids = new Map<string, string>()
  for (let page = 1; ; page++) {
    const listed = await request("/storage/kv/namespaces", {
      parse: parseNamespaces,
      query: { page: String(page), per_page: String(CLOUDFLARE_KV_NAMESPACE_LIST_PER_PAGE) },
    })
    const namespaces = listed.result ?? []
    for (const namespace of namespaces) {
      if (namespace.id && namespace.title && !ids.has(namespace.title)) ids.set(namespace.title, namespace.id)
    }
    const resultInfo = listed.result_info
    if (resultInfo?.total_pages !== undefined) {
      if (page >= resultInfo.total_pages) return ids
      continue
    }
    if (resultInfo?.total_count !== undefined) {
      const currentPage = resultInfo.page ?? page
      const pageSize = resultInfo.per_page ?? CLOUDFLARE_KV_NAMESPACE_LIST_PER_PAGE
      if (currentPage * pageSize < resultInfo.total_count) continue
      return ids
    }
    if (namespaces.length < CLOUDFLARE_KV_NAMESPACE_LIST_PER_PAGE) return ids
  }
}

async function createNamespace(request: CloudflareProvisionRequest, title: string): Promise<string | undefined> {
  try {
    const created = await request("/storage/kv/namespaces", { method: "POST", body: { title }, parse: parseNamespace })
    return created.result?.id
  }
  catch (error) {
    // Another run created the namespace after this plan listed it.
    const duplicate = error instanceof ProvisionRequestError
      && (error.status === 400 || error.status === 409 || error.codes.includes(CLOUDFLARE_KV_DUPLICATE_TITLE_CODE))
    if (!duplicate) throw error
    const id = (await listNamespaceIds(request)).get(title)
    if (!id) throw error
    return id
  }
}

// Groups Cloudflare KV Stores without a configured namespace id by namespace name.
function planStoresByNamespace(options: KVModuleOptions | undefined, env: Record<string, string | undefined>): Map<string, string[]> {
  const kv = resolveKVViteConfig(options, { env, hosting: "cloudflare" }).kv
  const storesByNamespace = new Map<string, string[]>()
  if (!kv) return storesByNamespace
  for (const [storeName, store] of Object.entries(kv.stores || { default: kv.store })) {
    if (store.driver !== "cloudflare-kv-binding" || store.namespaceId || !store.namespaceName) continue
    const stores = storesByNamespace.get(store.namespaceName)
    if (stores) stores.push(storeName)
    else storesByNamespace.set(store.namespaceName, [storeName])
  }
  return storesByNamespace
}

export function createKVCloudflareProvisionStep(resolveOptions: () => KVModuleOptions | undefined): ProvisionStep {
  return {
    id: "kv:cloudflare-kv",
    provider: "cloudflare",
    async plan(context) {
      const storesByNamespace = planStoresByNamespace(resolveOptions(), context.env)
      if (!storesByNamespace.size) return []

      const config = resolveCloudflareProvisionConfig(context.env)
      if (!config) {
        context.logger.warn("kv: skipping Cloudflare KV, missing CLOUDFLARE_ACCOUNT_ID/CLOUDFLARE_API_TOKEN.")
        return []
      }

      const request = createCloudflareProvisionClient(config, context.fetch)
      const existing = await listNamespaceIds(request)

      return [...storesByNamespace].map(([namespaceName, stores]): ProvisionAction => ({
        kind: "cloudflare-kv-namespace",
        name: namespaceName,
        exists: existing.has(namespaceName),
        apply: async () => {
          const id = existing.get(namespaceName) ?? await createNamespace(request, namespaceName)
          if (!id) throw kvErrorDiagnostics.KV_R0021({ message: `Cloudflare KV provisioning did not return an id for namespace ${JSON.stringify(namespaceName)}.` })
          return { ids: { cloudflare: { [KV_CLOUDFLARE_PROVISION_CATEGORY]: Object.fromEntries(stores.map(store => [store, id])) } } }
        },
      }))
    },
  }
}
