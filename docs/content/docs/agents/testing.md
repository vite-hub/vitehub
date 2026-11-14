---
title: Test an Agent
description: Check an Agent with unit tests, Evals, and a local run before you deploy.
navigation.title: Test an Agent
navigation.order: 51
navigation.group: Inspect and evaluate
icon: i-lucide-test-tube
navigation.kind: Guides
---

Each check below uses the same Agent Definition but answers a different
question. Use a `runAgent()` test for your own logic, an
[Eval](/docs/agents/evals) for model behavior, and `vitehub agent dev` for the
host.

| Check | What it proves | What it does not prove |
| --- | --- | --- |
| `runAgent()` test | Input validation, interception, custom `run` logic, and results. | Model quality, provider credentials, or host routes. |
| Agent Eval | A repeatable answer, tool choice, refusal, or usage limit. | Workflow recovery, provider startup on the deployed host, or deployment wiring. |
| `agent dev` smoke test | Discovery, the route, host runtime, and one real Invocation. | Behavior across many prompts. |
| Provider status | The provider executable and authentication path (local credentials or a gateway) are ready. | A successful Agent turn or tool result. |

Test at the smallest boundary that can fail. Do not replace the Agent's
Capabilities or Workspace in an Eval, or you test a different setup than your
app runs.

## Test application-owned logic

Use a custom `run` Driver when the application owns the operation.
`runAgent()` returns `[error, result]`, which makes a small unit test
independent of a Vite server and model credentials.

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

    expect(error).toBeUndefined()
    expect(result?.text).toBe('Hello, Ada!')
  })
})
```

For an input schema or an `intercept` handler, add one test for valid input
and one for rejection. A schema failure returns `AGENT_RUN_FAILED` with the
validation error as `error.cause`, and the Driver does not run. An interception result finishes the Invocation before the
Driver runs. See [Accept structured data](/docs/agents/agent-definitions#accept-structured-data)
and [Finish before the Driver](/docs/agents/agent-definitions#finish-before-the-driver).

Pass `runtimeContext` when the behavior depends on a host Runtime Context,
request metadata, or a stream's background lifetime:

```ts fragment
const [error, result] = await runAgent(agent, { prompt: 'Ada' }, { runtimeContext })
```

Pass a test Runtime Context with the parts the Agent uses. Fake network and
storage at your app's boundary. Do not fake the Capability lifecycle when you
test Capability setup or cleanup.

## Score model behavior with an Eval

An Eval runs a real Agent Definition inline. Keep credentials and the model in
the Agent file, and put the scenario and scorer in `*.eval.ts`:

```ts [server/agents/support.eval.ts] fragment
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

Run one file:

```bash
pnpm vitehub agent eval server/agents/support.eval.ts
```

Use a custom scorer when the rule is not a string match, and keep it to one
observation. A scenario can read the normalized `observation`, response text,
tool calls, Capability extensions, trace, and usage. Add
`staysUnderTokenBudget()` for token use regressions.

For a provider-backed Agent, the inline Eval starts the provider executable in
the Eval environment and can show local launch failures. It does not prove
provider startup on the deployed host, Workflow scheduling, durable recovery,
or Channel delivery. Test those separately.

Use `variants` to compare a model or instruction change on the same scenarios.
For changes to Capabilities, Workspace context, custom `run`, or host
settings, use a separate Agent Definition.

## Run a local smoke test

After you add or move an Agent file, start the Vite dev server and run the
Agent with `agent dev`:

```bash
pnpm vite dev
pnpm vitehub agent dev --agent support --prompt 'Summarize the support policy.'
```

This checks discovery, the dev route, input preparation, Capability setup,
the Driver, and streamed output together.

`--timeout <milliseconds>` sets the stream inactivity timeout, for a long tool
or provider turn that needs more time between events. It is not a deadline for
the whole Invocation. With `--cli` or a direct Workspace command, `--timeout`
is a wall-clock command deadline instead.

Before you debug model output, inspect the resolved Definition as JSON:

```bash
pnpm vitehub agent info --agent support --json
```

Check the Driver, Capabilities, Workspace Sources, instructions, warnings, and
metadata. `agent info` does not run the Driver. The
[CLI reference](/docs/development/cli#inspect-an-agent-definition) lists the
route and authentication needs for a dev server.

For a Capability CLI, add `--cli`:

```bash
pnpm vitehub agent dev --agent support --cli inventory -- items list --json
```

This runs the command directly. It does not test if a model picks that tool,
so keep an Eval for tool choice.

## Check provider readiness

Provider-backed Agents need a provider executable and an authentication path:
local credentials, or a `gateway` that replaces them. `vitehub agent info` does
not call the provider. To run the readiness probe, call the `status.get`
operation of the Console endpoint for the Agent:

```bash
curl -X POST \
  -H 'Content-Type: application/json' -H 'x-vitehub-console: 1' \
  --data '{"m":"status.get","a":[{"agent":"support"}],"t":"q","i":"1"}' \
  'http://localhost:5173/_vitehub/rpc'
```

The dev server takes this call without a signature when the app has no
`console` option or sets `console: { auth: false }`. A deployed app takes only
[signed requests](/docs/console/signed-requests): use a
`vitehub` command with `--url` and `VITEHUB_CONSOLE_PRIVATE_KEY_<NAME>` there.

This calls `agent.status()`. `ready` means the probe found enough executable,
authentication, and quota evidence. It runs no Agent turn. See
[Provider status](/docs/agents/provider-status) for access and response details.

After readiness passes, run a short real provider smoke test with tight
provider permissions. Status can be `unknown` when the provider shows no quota
evidence. That does not prove a turn will fail.

## Verify failures at the right layer

Fix the first layer that fails:

1. `agent info` fails: fix discovery or Definition configuration.
2. `agent dev` cannot start: check the host route, authentication path,
   requirements, and Capability requirements.
3. The Invocation starts but behaves wrong: add or update an Eval.
4. You cannot inspect or resume a completed Invocation: test the journal or
   Workflow on the target host.

Keep the command and its result with the change. If the change affects
discovery, a route, a provider, or persistence, a passing unit test does not
replace a host smoke test.

## Related guides

- [Invocations](/docs/agents/invocations)
- [Evals](/docs/agents/evals)
- [Agent Drivers](/docs/agents/agent-drivers)
- [Runtime policy](/docs/agents/runtime-policy)
