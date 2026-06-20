# Source Fetch Validates Requests, Not Responses

The request-shaped `source.fetch()` design validates model-shaped HTTP inputs, not response bodies. This revises ADR 0018's response `schema` direction: for controlled `curl`, ViteHub's safety boundary is the allowed URL, method, query, body, injected headers and cookies, Workspace Scope, and Shell Network Grant; response validation can be revisited separately when Source materialization needs a stronger typed output contract.

## Considered Options

- Response schemas on `source.fetch()` were rejected for this design because they do not protect the network boundary and add authoring weight to runtime data exploration.
- A public response lifecycle hook surface was deferred because ADR 0018 already rejected first-version public fetch hooks until plugin-level requirements are clearer.

## Consequences

Request validation remains Standard Schema-compatible. Controlled shell requests can return untyped JSON or text as ephemeral Shell observations. Existing response shaping behavior may be treated as legacy or future materialization-only behavior, but it should not define the controlled network access API.
