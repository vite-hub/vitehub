# Framework Integrations

Framework Integrations names how ViteHub packages connect portable declarations to Vite builds, Nitro servers, generated registries, and provider output.

## Language

**Definition**:
A portable user declaration that names work or state without depending on one framework runtime.
_Avoid_: Route, module config, runtime helper

**Discovered Definition**:
A Definition found by package-specific scanning rules.
_Avoid_: Import, route file, generated handler

**Discovery Identity**:
The stable name for a Discovered Definition, derived from its discovery location.
_Avoid_: Inline id, definition id override, parsed helper option

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

**Build-Extracted Definition Options**:
Definition Options read from the direct default-exported Definition Boundary Helper in a discovered definition file.
_Avoid_: Discovery Identity, source-scanned name, arbitrary helper extraction

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

**Definition Boundary Helper**:
A helper whose main role is marking a user file as a ViteHub Definition for discovery.
_Avoid_: Capability factory, invocation helper, runtime helper

**Discovered Definition Export**:
The direct default export of a package-owned Definition Boundary Helper from a discovered definition file.
_Avoid_: Named export aggregate, local binding indirection, helper call elsewhere in source

**Nitro Auto Import**:
A Nitro Integration convenience that makes selected ViteHub helpers available to server code without local import statements.
_Avoid_: generated import path, hidden capability, runtime wiring

**Stable ViteHub Import Path**:
A ViteHub-owned app-facing import specifier for generated or integration-backed surfaces.
_Avoid_: Virtual module path, generated file path, framework import path

## Relationships

- A **Definition** can become a **Discovered Definition**.
- A **Discovered Definition** has a **Discovery Identity**.
- **Discovery Identity** comes from discovery location rather than Definition Options parsed from user source.
- **Discovery Identity** is the framework discovery rule for all package-owned Discovered Definitions, not a package-specific rule.
- A **Vite Integration** can discover Definitions and generate Provider Output.
- A **Nitro Integration** can discover Definitions and write a Runtime Registry.
- A **Runtime Registry** contains Discovered Definitions.
- **Integration Options** are resolved into Runtime Config when runtime code needs them.
- **Definition Options** travel with one Definition.
- **Build-Extracted Definition Options** can be extracted only from the direct discovered default export, and only for non-identity Definition Options.
- **Invocation Options** are supplied to Runtime Helpers.
- **Nitro Auto Imports** should cover Definition Boundary Helpers and narrow read-oriented Runtime Helpers, not behavior-starting Invocation Helpers.
- **Definition Boundary Helpers** describe or validate a discovered Definition; they do not rename it.
- First-class discovered definition files use a **Discovered Definition Export**.
- A direct default-exported **Definition Boundary Helper** is the only source shape eligible for Build-Extracted Definition Options.
- **Provider Selection** belongs in Integration Options when it changes generated output, bindings, imports, or deployment behavior.
- Options should live as late as possible unless static analysis, type generation, provider binding, generated files, or deployment output require earlier placement.
- A **Stable ViteHub Import Path** can resolve to a Runtime Registry, Provider Output, virtual module, or generated file.
- Application code should import generated or integration-backed ViteHub surfaces through **Stable ViteHub Import Paths** unless an ADR makes another import path public.

## Example Dialogue

> **Dev:** "Should the sandbox provider be passed to every sandbox run?"
> **Domain expert:** "No. **Provider Selection** changes generated provider wiring, so it belongs in **Integration Options**. A stable sandbox id can be an **Invocation Option**."
>
> **Dev:** "Can app code import a framework virtual module directly?"
> **Domain expert:** "No. Use a **Stable ViteHub Import Path** unless an ADR explicitly makes the virtual module public."

## Flagged Ambiguities

- "composable" was used for runtime calls - resolved: use **Runtime Helper** unless referring to a Nuxt or Vue composable.
- Vite and Nitro behavior were considered part of Definitions - resolved: Definitions stay portable; framework-specific behavior belongs to **Vite Integration** or **Nitro Integration**.
- Provider fields were considered runtime-call options - resolved: use **Provider Selection** for provider choices that affect generated output or deployment binding.
- Framework virtual modules and generated file paths were treated as app-facing imports - resolved: use **Stable ViteHub Import Path** for app-facing imports, with framework-specific paths kept as integration details unless an ADR makes them public.
- Inline Definition Options were considered valid sources for discovered names - resolved: use **Discovery Identity** from discovery location instead.
- Discovery Identity was considered separately for schedules and workflows - resolved: use the same location-derived rule for every framework-discovered `defineX` surface.
- Static helper option extraction was considered generally valid from arbitrary local bindings - resolved: allow **Build-Extracted Definition Options** only from the direct discovered default export.
- Named exports and local binding indirection were considered valid discovered definition shapes - resolved: first-class discovered definition files use a direct default-exported package-owned Definition Boundary Helper.
