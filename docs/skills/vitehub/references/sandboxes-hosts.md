# Sandboxes and hosts

Use this for trusted-host commands, isolated execution, credentials projected into Home, required binaries, host links, deployment targets, or Provider Output.

## Select current pages

Open [Sandboxes](https://vitehub.dev/raw/docs/agents/sandboxes.md) for execution environments, the selected page under [Frameworks and hosts](https://vitehub.dev/raw/docs/frameworks-hosts.md) for a deployment target, or [Provider Output](https://vitehub.dev/raw/docs/reference/provider-output.md) for artifact ownership. Open only the pages matching the task.

## State the runtime boundary

Name the Sandbox provider or trusted host, isolation guarantee, persistence lifetime, network policy, required commands, projected credentials, cost, and production-readiness. A local tempdir or host process is convenience, not isolation.

Keep host-specific setup behind the Sandbox or provider boundary. Agent Instructions may explain available commands, but configuration must make the commands and credentials actually available.

## Link and deploy

- Run `vitehub link` to connect the project to its host project. It writes `.vitehub/link.json` and adds `.vitehub` to `.gitignore`, because the link belongs to one machine and must not follow forks or templates. `vitehub unlink` removes the file and leaves the host project as it is. See [Link a project to its host](https://vitehub.dev/raw/docs/development/cli.md#link-a-project-to-its-host).
- Host credentials come from environment variables, then from the host CLI login, such as `wrangler login`. Never write a token into a project `.env` or the link file. When `link` exits with `2`, run the login command or set the variable that its `fix` names.
- Deploy runs from the developer's machine by default. Add a GitHub CI deploy only when the developer asks for it.
- `vitehub deploy`, `vitehub deployments`, and `vitehub init` are not built yet. Build the app and deploy with the command that the selected host guide documents.

## Proof

Inspect the resolved Sandbox requirements, execute one required command, prove credential access without exposing the credential, and confirm cleanup or persistence. For deployment, build and inspect the documented Provider Output before a live target check.
