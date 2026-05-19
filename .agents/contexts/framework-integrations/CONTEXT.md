# Framework Integrations

Framework Integrations names how ViteHub packages connect portable declarations to Vite builds, Nitro servers, generated registries, and provider output.

## Language

**Definition**:
A portable user declaration that names work or state without depending on one framework runtime.
_Avoid_: Route, module config, runtime helper

**Discovered Definition**:
A Definition found by package-specific scanning rules.
_Avoid_: Import, route file, generated handler

**Vite Integration**:
The build and dev integration installed through a Vite plugin.
_Avoid_: Nitro module, runtime client

**Nitro Integration**:
The server integration installed through a Nitro module.
_Avoid_: Vite plugin, route helper

**Runtime Registry**:
A generated module that maps discovered names to lazy-loaded Definitions.
_Avoid_: Definition list, route table

**Provider Output**:
Generated deployment or runtime artifacts required by a provider.
_Avoid_: Runtime option, user handler

**Integration Options**:
Configuration passed to framework integrations such as Vite plugins, Vite config, Nitro modules, or Nitro config.
_Avoid_: Invocation options, definition options

**Definition Options**:
Portable options stored with a Definition.
_Avoid_: Integration options, provider config

**Invocation Options**:
Runtime per-call options passed when starting or using a Definition.
_Avoid_: Module config, build config

**Runtime Config**:
Resolved configuration made available to server runtime code after an integration has run.
_Avoid_: User options, provider output

**Provider Selection**:
An Integration Option that chooses the provider used for generated output, bindings, imports, or deployment behavior.
_Avoid_: Invocation option, runtime helper option

**Runtime Helper**:
A runtime API used by application code to call, inspect, or use a configured ViteHub primitive.
_Avoid_: Composable, Vite plugin, Nitro module

## Relationships

- A **Definition** can become a **Discovered Definition**.
- A **Vite Integration** can discover Definitions and generate Provider Output.
- A **Nitro Integration** can discover Definitions and write a Runtime Registry.
- A **Runtime Registry** contains Discovered Definitions.
- **Integration Options** are resolved into Runtime Config when runtime code needs them.
- **Definition Options** travel with one Definition.
- **Invocation Options** are supplied to Runtime Helpers.
- **Provider Selection** belongs in Integration Options when it changes generated output, bindings, imports, or deployment behavior.
- Options should live as late as possible unless static analysis, type generation, provider binding, generated files, or deployment output require earlier placement.

## Example Dialogue

> **Dev:** "Should the sandbox provider be passed to every sandbox run?"
> **Domain expert:** "No. **Provider Selection** changes generated provider wiring, so it belongs in **Integration Options**. A stable sandbox id can be an **Invocation Option**."

## Flagged Ambiguities

- "composable" was used for runtime calls - resolved: use **Runtime Helper** unless referring to a Nuxt or Vue composable.
- Vite and Nitro behavior were considered part of Definitions - resolved: Definitions stay portable; framework-specific behavior belongs to **Vite Integration** or **Nitro Integration**.
- Provider fields were considered runtime-call options - resolved: use **Provider Selection** for provider choices that affect generated output or deployment binding.
