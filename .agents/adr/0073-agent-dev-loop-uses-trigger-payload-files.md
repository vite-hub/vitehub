# 0073 Agent Dev Loop Uses Trigger Payload Files

ViteHub will model Agent Dev Loop fixtures as **Agent Trigger Payload** JSON files loaded through `vitehub agent dev --payload <path>`.

## Context

The earlier Agent Dev Loop shape used `--context <path>` for Agent Invocation Context Values and allowed nearby development-only sample ideas such as `dev.samples` or `devtools.meta`. That made local fixtures look like Agent Definition configuration even though they are run-specific event input.

## Decision

The Agent Dev Loop payload file is raw input for the selected **Agent Trigger**. The trigger owns mapping that payload into trusted **Agent Invocation Context Values**, **Agent Run** metadata, actor information, delivery behavior, or prompt input.

`vitehub agent dev` keeps prompt/message flags for convenience, but removes the legacy `--context` and `--input` shapes. The CLI loads one object from `--payload <path>` and sends it to the Agent Invocation Stream Endpoint as `payload`.

Agent Definitions must stay production-shaped. Do not add `devtools.meta`, `dev.samples`, `dev.presets.json`, or similar preset configuration to Agent Definitions. Runnable local examples live as explicit payload files selected by the dev loop.

## Consequences

This is a breaking local-development API. Existing `dev.context.json` files should become trigger payload files, usually named `dev.payload.json`.

For `chat.message`, payload files use chat trigger input fields such as `messages`, `user`, `session`, `meta`, and `run`. For Channel triggers such as GitHub webhooks, payload files should mirror the Channel's trigger input, such as webhook `payload` plus provider facts.

This keeps app-specific sample data out of the Agent Definition and makes the CLI path match the same trigger boundary used by routes, Channels, webhooks, and DevTools consumers.
