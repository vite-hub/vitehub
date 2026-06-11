import { defineCapability } from "../capability-runtime.ts"
import { resolveInvocationProfile } from "../invocation-profile.ts"

import type {
  AgentAdapterInstructionsValue,
  AgentCapabilityDefinition,
  AgentCapabilityRuntimeContext,
  AgentRuntimeConfig,
  MaybePromise,
} from "../types.ts"
import type { AgentInvocationProfileDefinition } from "../invocation-profile.ts"
import type { WorkspaceName } from "@vite-hub/workspace"

export type AudienceInstructionsResolver<
  TProfile = unknown,
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
> = (
  context: AgentCapabilityRuntimeContext<TRuntimeConfig, Name> & { profile: TProfile },
) => MaybePromise<AgentAdapterInstructionsValue | false | undefined>

export interface AudienceCapabilityOptions<
  TProfile = unknown,
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
> {
  id?: string
  instructions:
    | AgentAdapterInstructionsValue
    | false
    | AudienceInstructionsResolver<TProfile, TRuntimeConfig, Name>
  profile?: AgentInvocationProfileDefinition<TProfile, TRuntimeConfig, Name, any>
}

export function audience<
  TProfile = unknown,
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
>(
  options: AudienceCapabilityOptions<TProfile, TRuntimeConfig, Name>,
): AgentCapabilityDefinition<TRuntimeConfig, Name> {
  if (!options || typeof options !== "object") {
    throw new TypeError("[vitehub] audience() requires options.")
  }
  const id = options.id || "audience"
  return defineCapability({
    id,
    metadata: {
      kind: "audience",
      ...(options.profile ? { profile: options.profile.id } : {}),
    },
    async prepare(context) {
      const profile = options.profile
        ? await resolveInvocationProfile(options.profile, context as AgentCapabilityRuntimeContext<TRuntimeConfig, Name>)
        : undefined
      const instructions = typeof options.instructions === "function"
        ? await options.instructions({ ...context, profile } as AgentCapabilityRuntimeContext<TRuntimeConfig, Name> & { profile: TProfile })
        : options.instructions
      context.instructions.add(instructions, { id })
    },
  })
}
