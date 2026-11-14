import type { CloudflareSandboxOptions } from '../../../index.ts'
import { resolveCloudflareSandbox } from '../../../internal/cloudflare.ts'
import { getActiveCloudflareEnv } from '@vite-hub/internal/runtime/cloudflare-env'
import type { CloudflareSandboxTaskDefinitionProviderOptions, SandboxTaskDefinitionOptions } from '../../module-types'
import { sandboxTaskErrorDiagnostics } from "../../error-diagnostics.ts"

type SandboxTaskOptions = {
  local: SandboxTaskDefinitionOptions
  provider: CloudflareSandboxTaskDefinitionProviderOptions
}

/** Resolve the Sandbox namespace from the bindings of the active Cloudflare request. */
export async function resolveCloudflareTaskSandbox(options: SandboxTaskOptions) {
  const env = getActiveCloudflareEnv()
  const bindingName = options.provider.binding || 'SANDBOX'
  // Only explicitly declared Worker bindings can select a Sandbox namespace.
  const namespace = env && Object.hasOwn(env, bindingName) ? env[bindingName] : undefined

  if (!namespace) {
    throw sandboxTaskErrorDiagnostics.SANDBOX_TASK_R0071({
      message: `Cloudflare sandbox requires the "${bindingName}" binding. Set sandbox.binding or run inside Cloudflare. `
        + "The cloudflare preset writes the binding and its Container to .output/server/wrangler.json, and the Vite or "
        + "Nuxt dev server cannot host them: build, then run `npx wrangler dev --config .output/server/wrangler.json` (needs Docker).",
    })
  }

  return {
    provider: 'cloudflare' as const,
    sandboxId: options.provider.sandboxId,
    resolveSandbox: async (requirements: readonly string[]) => await resolveCloudflareSandbox(
      {
        namespace: namespace as CloudflareSandboxOptions['namespace'],
        sandboxId: options.provider.sandboxId,
        cloudflare: {
          sleepAfter: options.provider.sleepAfter ?? '5m',
          keepAlive: options.provider.keepAlive,
          normalizeId: options.provider.normalizeId,
        },
      },
      requirements,
    ),
  }
}
