# Agent Evaluations Use Generic API Over Evalite Engine

ViteHub Agent Evaluation uses a generic `@vitehub/agent/eval` API with `defineEval()` and eval files colocated beside Agent Definitions. `*.eval.ts` resolves to a sibling Agent Definition with the same base name; folder-level `eval.ts` resolves to sibling `config.ts` and uses the folder name as the evaluation name. Evalite v1 beta is the first execution engine for local runs, watch mode, UI, CI, variants, traces, and scorer execution, but Evalite is not the domain model or public abstraction.

## Considered Options

- Exposing Evalite directly was rejected because it would make ViteHub users wire Agent Definitions, runtime context, workspace setup, variants, observations, and agent-specific scorers themselves.
- Building a standalone ViteHub eval runner was rejected for v1 because Evalite already owns the generic local evaluation loop, reports, and CI integration.
- Placing evaluations inside `defineAgent()` was rejected because development feedback would bloat runtime Agent Definitions.
- Central eval suites were rejected for the default path because ViteHub definitions are usually discovered from colocated files and the target Agent Definition should be inferable.
- Full Agent Definition variants were rejected for v1 because changing capabilities, workspace, custom run behavior, or provider changes the agent boundary rather than just the model or instruction comparison.

## Consequences

An Agent Evaluation Definition is one default export from a colocated eval file and targets the colocated Agent Definition by default. Evaluations are scenario-first, use global variants, and produce Agent Observations scored by rich Agent Scorers. V1 variants only change name, model, and replacement instructions; omitted variants run the Agent Definition as an implicit baseline.

Arena, human review, deferred scoring, and other long-running feedback techniques are future extensions over Agent Observations rather than part of the v1 Evalite wrapper.
