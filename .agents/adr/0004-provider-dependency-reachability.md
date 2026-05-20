# Provider Dependency Reachability

ViteHub packages with provider-specific runtime dependencies will expose provider-specific runtime modules or Provider Outputs so only the selected provider's dependencies are reachable from generated runtime bundles. Provider modules may be thin wrappers around shared implementation SDKs, but the wrapper boundary must still match the provider boundary so one provider does not require, bundle, or externalize another provider's runtime dependency.

## Considered Options

- Package-level provider switches were rejected for generated runtime bundles because a single module can make every provider dependency reachable even when only one provider is selected. Legacy public umbrella modules may remain for compatibility, but Provider Outputs should not route through them.
- Reimplementing provider SDK behavior was rejected because shared SDKs such as Files SDK already provide useful provider integrations.
- Relying only on tree-shaking or broad external lists was rejected because generated Provider Outputs should have explicit runtime dependency contracts.

## Consequences

Blob Driver Modules own runtime provider dependency reachability and can wrap Files SDK provider subpaths. Runtime-native providers use hosting runtime bindings, while SDK-backed providers make only their selected provider SDK reachable in generated Provider Output. This decision does not promise package install-footprint isolation when a shared SDK is installed as the integration layer.
