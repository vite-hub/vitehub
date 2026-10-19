---
title: Test an Agent
description: Check Agent contracts with deterministic tests, Evals, and a local invocation before you deploy.
navigation.title: Test an Agent
navigation.order: 62
navigation.group: Verify
icon: i-lucide-test-tube
---

Test an Agent at the boundary where its behavior matters. Use a direct
`runAgent()` test for application-owned logic, an [Eval](/docs/agents/evals)
for model behavior, and `vitehub agent dev` for the host integration. These
checks use the same Agent Definition. They answer different questions.

| Check | What it proves | What it does not prove |
| --- | --- | --- |
| `runAgent()` test | Input validation, interception, custom `run` logic, and result handling. | Model quality, provider credentials, or host routes. |
| Agent Eval | A repeatable model response, tool choice, refusal, or usage limit. | Workflow recovery, provider startup on the deployed host, or deployment wiring. |
| `agent dev` smoke test | Discovery, the route, host runtime, and one real Invocation. | Behavior across many prompts. |
| Provider status | The configured provider executable and authentication path (local credentials or a gateway) are ready. | A successful Agent turn or tool result. |

Keep the test at the smallest boundary that can fail. Do not replace the
Agent's Capabilities or Workspace in an Eval. That would test a different
configuration from the one your application runs.

## Test application-owned logic

Use a custom `run` Driver when the application owns the operation. The
two-argument `runAgent()` form returns `[error, result]`, which makes a small
unit test independent of a Vite server and model credentials.

```ts [server/agents/greeting.ts]
import { defineAgent } from 'vite-hub/agent'

export default defineAgent({
  runtime: false,
  driver: {
    run({ prompt }) {
      const name = typeof prompt === 'string' ? prompt : 'friend'
      return { text: `Hello, ${name}!` }
    },
  },
})
```

```ts [server/agents/greeting.test.ts]
import { describe, expect, it } from 'vitest'
import { runAgent } from 'vite-hub/agent'
import greeting from './greeting'

describe('greeting Agent', () => {
  it('returns the name from the prompt', async () => {
    const [error, result] = await runAgent(greeting, { prompt: 'Ada' })

    expect(error).toBeNull()
    expect(result).toEqual({ text: 'Hello, Ada!' })
  })
})
```

For an input schema or an `intercept` handler, add one test for valid input
and one for rejection. A schema failure returns an error tuple and the Driver
does not run. An interception result finishes the Invocation before the
Driver runs. See [Accept structured data](/docs/agents/agent-definitions#accept-structured-data)
and [Finish before the Driver](/docs/agents/agent-definitions#finish-before-the-driver).

Use the three-argument form when the behavior depends on a host
`RuntimeContext`, request metadata, or a stream's background lifetime. That
form throws invocation failures and returns the result directly:

```ts
const result = await runAgent(agent, runtimeContext, { prompt: 'Ada' })
```

Pass a test Runtime Context that implements the parts the Agent uses. Keep
network and storage fakes at the application boundary. Do not fake the
Capability lifecycle when the behavior under test is Capability setup or
cleanup.

## Score model behavior with an Eval

An Eval runs a real Agent Definition inline. Keep credentials and the model in
the Agent file, then describe the scenario and scorer in `*.eval.ts`:

```ts [server/agents/support.eval.ts]
import { callsTool, defineEval, textContains } from 'vite-hub/agent/eval'
import support from './support'

export default defineEval({
  agent: support,
  scenarios: [{
    name: 'answers from the support Source',
    input: { prompt: 'Where is the billing retry policy?' },
    scorers: [
      callsTool('shell'),
      textContains('billing'),
    ],
  }],
})
```

Run one file with:

```bash
pnpm vitehub agent eval server/agents/support.eval.ts
```

Use a custom scorer when the product rule is not a string match. Keep the
scorer focused on one observation. A scenario can inspect the normalized
`observation`, response text, tool calls, Capability extensions, trace, and
usage. Add `staysUnderTokenBudget()` when a regression is about token use.

Evals run the Agent inline. For a provider-backed Agent, this starts the
configured provider executable in the Eval environment and can expose local
launch failures. It does not prove provider startup on the deployed host,
Workflow scheduling, durable recovery, or Channel delivery. Exercise those
boundaries separately.

Use `variants` to compare a model or instruction change against the same
scenarios. Use a separate Agent Definition when the change affects
Capabilities, Workspace context, custom `run` behavior, or host settings.

## Run a local smoke test

After adding or moving an Agent file, start a Vite Development Server and
exercise the discovered Agent through the Agent Dev Loop:

```bash
pnpm vite dev
pnpm vitehub agent dev --agent support --prompt 'Summarize the support policy.'
```

This checks discovery, the development route, input preparation, Capability
setup, the Driver, and streamed output together. Use `--timeout <milliseconds>`
to set the stream inactivity timeout for a normal streamed Agent Invocation
when a valid long-running tool or provider turn needs more time between emitted
events; it is not a wall-clock deadline for the whole Invocation. For
machine-readable Definition data, use `agent info --json` below. When using
`--cli` or a direct Workspace command, `--timeout` is a wall-clock command
deadline instead.

Inspect the resolved Definition before debugging model output:

```bash
pnpm vitehub agent info --agent support --json
```

Check the selected Driver, Capabilities, Workspace Sources, instructions,
warnings, and metadata in this output. `agent info` does not invoke the Driver.
The [CLI reference](/docs/development/cli#inspect-an-agent-definition) lists the route
and authentication requirements for a development server.

For a Capability CLI, use the same smoke test with `--cli`:

```bash
pnpm vitehub agent dev --agent support --cli inventory -- items list --json
```

This invokes the command directly. It does not test whether a model chooses
that tool, so keep a separate Eval for tool selection.

## Check provider readiness

Provider-backed Agents need a provider executable and an authentication path:
local credentials for a local provider, or a configured `gateway`, which replaces
local credentials. `vitehub agent info` only inspects the resolved Definition;
it does not call the provider. To run the readiness probe, expose the authenticated
Console status endpoint and select the Agent, for example:

```bash
curl -H "Cookie: $VITEHUB_CONSOLE_COOKIE" \
  'http://localhost:5173/api/_vitehub/console/status?agent=support'
```

`VITEHUB_CONSOLE_COOKIE` is the cookie copied from a signed-in Console session
(`vitehub_console.session_token`, with a `__Secure-` prefix over HTTPS). If the
host uses a separate bearer policy, send its accepted header instead:
`curl -H "Authorization: $VITEHUB_CONSOLE_AUTHORIZATION" ...`. These are CLI
environment variables; `VITEHUB_CONSOLE_TOKEN` is not a ViteHub setting. This
calls `agent.status()`. A `ready` status means the provider probe found
enough executable, authentication, and quota evidence. It does not run an Agent
turn. See [Provider status](/docs/agents/provider-status) for Console access and
response details.

Use a real provider smoke test after readiness passes. Keep it short and
explicitly bound the provider permissions. Provider status may be `unknown`
when the provider does not expose quota evidence; treat that as an inspection
result, not as proof that a turn will fail.

## Verify failures at the right layer

When a check fails, use the first failing boundary:

1. `agent info` fails: fix discovery or Definition configuration.
2. `agent dev` cannot start: check the host route, authentication path, requirements,
   and Capability requirements.
3. The Invocation starts but behavior is wrong: add or update an Eval.
4. A completed Invocation cannot be inspected or resumed: test the selected
   journal or Workflow on the target host.

Keep the command and observed result with the change. A passing unit test does
not replace a host smoke test when the change affects discovery, a route, a
provider, or persistence.

## Related guides

- [Invocations](/docs/agents/invocations)
- [Evals](/docs/agents/evals)
- [Agent Drivers](/docs/agents/agent-drivers)
- [Runtime policy](/docs/agents/runtime-policy)
