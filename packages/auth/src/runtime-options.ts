import { resolvePublicUrl } from "@vite-hub/runtime"
import { normalizeAuthBasePath } from "./shared.ts"

import type {
  AuthBetterAuthRuntimeOptions,
  AuthDefinition,
  AuthDefinitionResolver,
  AuthRuntimeContext,
  AuthRuntimeOptions,
  AuthRuntimeOptionsResolver,
} from "./types.ts"

function isPlainObject(value: unknown): value is Record<string, unknown> {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Validate opaque option metadata before inspecting its fields.
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function isAuthDatabaseMetadata(value: unknown): boolean {
  return value === true
    || (
      isPlainObject(value)
      // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Validate metadata fields at the untrusted options boundary.
      && typeof value.name === "string"
      && Object.keys(value).every(key => key === "dedicated" || key === "name")
    )
}

function isAuthSecondaryStorageMetadata(value: unknown): boolean {
  return value === true
    || (
      isPlainObject(value)
      // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Validate metadata fields at the untrusted options boundary.
      && typeof value.store === "string"
      && Object.keys(value).every(key => key === "store")
    )
}

function stripViteHubOptions(
  options: AuthRuntimeOptions & Record<string, unknown>,
): AuthBetterAuthRuntimeOptions {
  const {
    access: _access,
    database,
    route: _route,
    runtime: _runtime,
    secondaryStorage,
    ...rest
  } = options

  // SAFETY: `rest` and the retained metadata fields are the Better Auth runtime option shape after ViteHub-only fields are removed.
  return {
    ...rest,
    ...(!isAuthDatabaseMetadata(database) ? { database } : {}),
    ...(!isAuthSecondaryStorageMetadata(secondaryStorage) ? { secondaryStorage } : {}),
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Better Auth accepts a string base path; malformed JavaScript input is ignored.
    basePath: normalizeAuthBasePath(typeof options.basePath === "string" ? options.basePath : undefined),
  } as AuthBetterAuthRuntimeOptions
}

/** Resolves one coherent option snapshot before projecting it for Better Auth or host callers. */
export function resolveAuthOptions(
  definition: AuthDefinition,
  input: {
    env?: (event?: unknown) => Record<string, unknown>
    event?: unknown
    request?: Pick<Request, "headers" | "url">
    runtimeOptions?: AuthRuntimeOptions
  } = {},
) {
  const { request } = input
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Definitions accept either static options or a resolver callback.
  const callback = typeof definition.options === "function"
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Definitions accept either static options or a resolver callback.
  const staticRequestRuntime = request && typeof definition.options !== "function" ? definition.options.runtime : undefined
  const usesContext = !request || callback || Boolean(staticRequestRuntime)
  const context: AuthRuntimeContext = {
    env: usesContext ? input.env?.(input.event ?? request) ?? {} : {},
    ...(request ? { request } : {}),
    requestOrigin: usesContext && request ? new URL(request.url).origin : "http://localhost",
  }
  // SAFETY: The callback branch returns AuthRuntimeOptions and the static branch is typed as AuthRuntimeOptions by AuthDefinition.
  const declared = (callback
    // SAFETY: `callback` is true only when definition.options is the AuthDefinitionResolver branch.
    ? (definition.options as AuthDefinitionResolver)(context)
    : definition.options) as AuthRuntimeOptions & Record<string, unknown>
  const runtime = request && !callback ? staticRequestRuntime : declared.runtime
  const resolvedRuntime = !runtime
    ? {}
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Runtime options intentionally support a resolver callback.
    : typeof runtime === "function"
      // SAFETY: The function branch of AuthRuntimeConfiguration is AuthRuntimeOptionsResolver.
      ? (runtime as AuthRuntimeOptionsResolver)(context)
      : runtime
  // SAFETY: These spreads combine only resolved AuthRuntimeOptions while retaining the definition's enumerable metadata.
  let requestRuntimeOptions = {
    ...(callback ? declared : {}),
    ...resolvedRuntime,
    ...input.runtimeOptions,
  } as AuthRuntimeOptions & Record<string, unknown>
  if (request) {
    const baseURL = requestRuntimeOptions.baseURL || resolvePublicUrl({ request })
    const staticTrustedOrigins = !callback && Object.hasOwn(declared, "trustedOrigins")
    // SAFETY: Origin defaults preserve the runtime options shape and add only supported Better Auth fields.
    requestRuntimeOptions = {
      ...(!Object.hasOwn(requestRuntimeOptions, "trustedOrigins") && !staticTrustedOrigins ? { trustedOrigins: [baseURL] } : {}),
      ...requestRuntimeOptions,
      baseURL,
    } as AuthRuntimeOptions & Record<string, unknown>
  }
  let snapshot: AuthRuntimeOptions & Record<string, unknown> | undefined
  const resolveSnapshot = () => snapshot ??= callback ? requestRuntimeOptions : { ...declared, ...requestRuntimeOptions }
  return {
    get options() { return resolveSnapshot() },
    get providerOptions() { return stripViteHubOptions(resolveSnapshot()) },
    requestRuntimeOptions,
  }
}
