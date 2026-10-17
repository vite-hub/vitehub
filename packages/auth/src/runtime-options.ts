import { resolvePublicUrl } from "@vite-hub/runtime"
import { resolveAuthMountPath } from "./application-path.ts"
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
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function isAuthDatabaseMetadata(value: unknown): boolean {
  return value === true
    || (
      isPlainObject(value)
      && Object.hasOwn(value, "name")
      && typeof value.name === "string"
      && Object.keys(value).every(key => key === "dedicated" || key === "name")
    )
}

function isAuthSecondaryStorageMetadata(value: unknown): boolean {
  return value === true
    || (
      isPlainObject(value)
      && Object.hasOwn(value, "store")
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
    // Better Auth appends this path to an origin `baseURL`, so the app base path keeps routes and callbacks below it.
    basePath: resolveAuthMountPath(normalizeAuthBasePath(typeof options.basePath === "string" ? options.basePath : undefined)),
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
  const callback = typeof definition.options === "function"
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
