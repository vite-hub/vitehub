# Sandboxes and hosts

Use this for trusted-host commands, isolated execution, credentials projected into Home, required binaries, host links, deployment targets, or Provider Output.

## Select current pages

Open [Sandboxes](https://vitehub.dev/raw/docs/agents/sandboxes.md) for execution environments, the selected page under [Frameworks and hosts](https://vitehub.dev/raw/docs/frameworks-hosts.md) for a deployment target, or [Provider Output](https://vitehub.dev/raw/docs/reference/provider-output.md) for artifact ownership. Open only the pages matching the task.

## State the runtime boundary

Name the Sandbox provider or trusted host, isolation guarantee, persistence lifetime, network policy, required commands, projected credentials, cost, and production-readiness. A local tempdir or host process is convenience, not isolation.

Keep host-specific setup behind the Sandbox or provider boundary. Agent Instructions may explain available commands, but configuration must make the commands and credentials actually available.

## Host setup and deployment

- Use `vitehub link` to connect the project to its host project and `vitehub unlink` to remove the local link. See [Host links](https://vitehub.dev/raw/docs/development/cli.md#link-a-project-to-its-host) for host selection and project options.
- Use environment variables or the host CLI login, such as `wrangler login`, for host credentials. Never write a token into a project `.env`.
- Deploy runs from the developer's machine by default. Add a GitHub CI deploy only when the developer asks for it.
- `vitehub init` creates or adopts an app, and `vitehub deploy` builds and deploys it with the local host login. Follow the selected host guide for host requirements. `vitehub deployments` is not available yet.

## Proof

Inspect the resolved Sandbox requirements, execute one required command, prove credential access without exposing the credential, and confirm cleanup or persistence. For deployment, build and inspect the documented Provider Output before a live target check.
