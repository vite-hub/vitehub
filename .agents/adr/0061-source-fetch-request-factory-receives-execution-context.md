# Source Fetch Request Factory Receives Execution Context

`fetch()` keeps a static Source definition, but its execution-time `request` factory may receive a narrow **Source Request Callback Context**. This revises ADR 0018's zero-argument request factory rule. The callback exists for credentials, cookies, timeouts, request signing, and request-local server state; it must not define or override Source identity, URL, method, Workspace placement, request schemas, Source Instructions, or cache policy.

The callback context includes the normalized outbound request facts after Source Request Shape validation and schema defaulting, plus Source identity, Workspace identity, Selected Workspace Scope, trusted invocation context when available, run metadata when available, and host/server runtime context when available. These values are read-only inputs so credential code can sign the exact request that will be sent without making the Source definition dynamic.

## Considered Options

- `fetch(() => options)` was rejected because Source identity, Source Request Descriptors, Source Network Grants, and Source-Backed Paths must be discoverable without executing user code.
- Per-key credential callbacks were rejected because they fragment request signing and make common credential logic awkward.
- A zero-argument request factory was too narrow for controlled `curl`, because injected credentials may need the final validated method, URL, query, and body.
- Passing raw runtime config was rejected by ADR 0012 and ADR 0018; application secrets should still be read through Server Env and Secret Env.

## Consequences

The request factory return type is restricted to execution-only additions such as headers, cookies, and timeout. It cannot return `url`, `method`, `query`, `body`, `querySchema`, `bodySchema`, `workspacePath`, `instructions`, or cache settings. For Source-Backed Path reads, the request facts come from concrete request parts or Schema-Derived Default Requests. For controlled shell requests, the request facts come from the validated `curl` request before credentials are injected.
