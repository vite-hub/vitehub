# Nitro Auto Import Boundaries

ViteHub Nitro modules auto-import helpers that mark definition boundaries or provide narrow read-oriented access to integration-backed state. They do not auto-import capability factories or invocation helpers that expose model tools, enqueue work, start workflows, construct provider clients, or otherwise change runtime behavior.

This keeps colocated definition files light without hiding meaningful behavior. `defineAgent`, `defineChat`, `defineWorkspace`, `defineWorkflow`, and `defineQueue` are definition boundary helpers and can be auto-imported. `useWorkspace`, `useServerEnv`, `getWorkflowRun`, and `getQueue` are read-oriented runtime helpers and can be auto-imported when the relevant Nitro module owns their generated runtime context. Capability factories such as `bash()` and `chat()` stay explicit, as do invocation helpers such as `runWorkflow`, `deferWorkflow`, `runQueue`, and `deferQueue`.

The trade-off is that some examples keep one or two extra import lines. That is intentional: imports should remain visible when a file grants model-facing tools or starts asynchronous work.
