# Invocation Profiles Drive Capability Effects

ViteHub will use reusable Invocation Profiles to resolve trusted invocation context once and let concrete Capabilities consume the selected profile for their own effects. This keeps `access()` focused on enforcing Workspace Scope, lets `audience()` contribute model-facing instructions, and avoids both `defineAgent({ profiles })` ceremony and a standalone no-effect profile Capability.

**Considered Options**

- Put profiles under `defineAgent({ profiles })`: rejected because the concept has not earned top-level Agent Definition status.
- Make `profile()` a Capability: rejected because a classifier without tools, instructions, triggers, or policy weakens the Capability concept.
- Call the concept `invoker`: rejected because it sounds like the caller or trigger that starts an Agent Invocation.
