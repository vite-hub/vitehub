# Boxes and hosts

Use this for trusted-host commands, isolated execution, credentials projected into Home, required binaries, deployment targets, or Provider Output.

## Select current pages

Open [Boxes](https://vitehub.dev/raw/docs/agents/boxes.md) for execution environments, the selected page under [Frameworks and hosts](https://vitehub.dev/raw/docs/frameworks-hosts.md) for a deployment target, or [Provider Output](https://vitehub.dev/raw/docs/reference/provider-output.md) for artifact ownership. Open only the pages matching the task.

## State the runtime boundary

Name the Box provider or trusted host, isolation guarantee, persistence lifetime, network policy, required commands, projected credentials, cost, and production-readiness. A local tempdir or host process is convenience, not isolation.

Keep host-specific setup behind the Box or provider boundary. Agent Instructions may explain available commands, but configuration must make the commands and credentials actually available.

## Proof

Inspect the resolved Box requirements, execute one required command, prove credential access without exposing the credential, and confirm cleanup or persistence. For deployment, build and inspect the documented Provider Output before a live target check.
