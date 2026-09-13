import * as v from "valibot"

const writableSkillFilesystem = v.object({ writeFile: v.function() })

/** Match the storage support required for retaining Capability-owned Skills. */
export async function supportsSkillPersistence(workspace: {
  fs: object
  capabilities?(): Promise<{ conditionalWrites: boolean }>
} | undefined): Promise<boolean> {
  return !!workspace
    && v.is(writableSkillFilesystem, workspace.fs)
    && !!(await workspace.capabilities?.())?.conditionalWrites
}

export function skillPersistenceGuidance(persistent: boolean): string {
  return persistent ? "This Skill persists between invocations." : "This Skill is available only for this invocation."
}
