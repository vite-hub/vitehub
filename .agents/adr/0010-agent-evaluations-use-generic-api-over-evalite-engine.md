# Agent Evaluations Use Generic API Over Evalite Engine

ViteHub Agent Evaluation uses a generic `@vite-hub/agent/eval` API with `defineEval()` and eval files colocated beside Agent Definitions. `*.eval.ts` resolves to a sibling Agent Definition with the same base name; folder-level `eval.ts` resolves to sibling `config.ts` and uses the folder name as the evaluation name. Evalite v1 beta is the first execution engine for local runs, watch mode, UI, CI, variants, traces, and scorer execution, but Evalite is not the domain model or public abstraction.

Agent Eval Runner configuration belongs to the Agent Package integration surface as `agent.eval`, not under `agent.cli` and not in a repository-level Evalite config file. ViteHub may generate Evalite-compatible Provider Output under `.vitehub/agent`, such as an internal `evalite.config.ts`, when the Evalite engine needs file-based configuration. That generated file is an implementation artifact, similar to generated Drizzle config under `.vitehub/database`, and application code should continue to configure Agent Evals through ViteHub's Agent integration.

## Considered Options

- Exposing Evalite directly was rejected because it would make ViteHub users wire Agent Definitions, runtime context, workspace setup, variants, observations, and agent-specific scorers themselves.
- Building a standalone ViteHub eval runner was rejected for v1 because Evalite already owns the generic local evaluation loop, reports, and CI integration.
- Placing evaluations inside `defineAgent()` was rejected because development feedback would bloat runtime Agent Definitions.
- Central eval suites were rejected for the default path because ViteHub definitions are usually discovered from colocated files and the target Agent Definition should be inferable.
- Full Agent Definition variants were rejected for v1 because changing capabilities, workspace, custom run behavior, or provider changes the agent boundary rather than just the model or instruction comparison.
- Keeping durable Agent Eval defaults in app-authored `evalite.config.ts` was rejected because it makes Evalite the user-facing configuration model for ViteHub Agent Evals.
- Placing Agent Eval options under `agent.cli.eval` was rejected because options such as timeout, concurrency, cache, setup files, and watch triggers describe Agent Eval execution rather than CLI command wiring.
- Passing an Evalite config path through `vitehub agent eval --config` was rejected because the ViteHub command should not expose Evalite-specific configuration mechanics as its public contract.

## Consequences

An Agent Evaluation Definition is one default export from a colocated eval file and targets the colocated Agent Definition by default. Evaluations are scenario-first, use global variants, and produce Agent Observations scored by rich Agent Scorers. V1 variants only change name, model, and replacement instructions; omitted variants run the Agent Definition as an implicit baseline.

The Agent Package can expose `agent.eval` options for Evalite-backed execution concerns such as force-rerun triggers, test timeout, max concurrency, setup files, trial count, cache behavior, score threshold, table visibility, storage, and server options. The Agent Eval Runner can translate those options into generated `.vitehub/agent` artifacts or direct runner options while keeping the app root and eval file discovery model stable. Generated Agent Eval setup may bridge app-owned Server Env into local eval execution so eval files do not have to reconstruct the app's Runtime Env object by hand.

Arena, human review, deferred scoring, and other long-running feedback techniques are future extensions over Agent Observations rather than part of the v1 Evalite wrapper.
