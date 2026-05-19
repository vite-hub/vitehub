# Workflow Package

Workflow Package names ownership boundaries for `@vitehub/workflow`.

## Language

**Workflow Package**:
The package that owns long-running work Definitions, workflow runs, workflow steps, and workflow provider integration.
_Avoid_: Queue package, job package

**Workflow Definition**:
A portable declaration of long-running work.
_Avoid_: Queue handler, provider workflow

**Workflow Run**:
One provider-tracked execution of a Workflow Definition.
_Avoid_: Queue job, request handler

**Workflow Step**:
A named unit of work inside a Workflow Run that a provider may checkpoint or retry.
_Avoid_: Function call, queue message

**Workflow Provider**:
The backend that starts, tracks, and resumes Workflow Runs.
_Avoid_: Workflow Definition, runtime helper

**Workflow Start**:
The runtime action of asking a Workflow Provider to begin a Workflow Run.
_Avoid_: Direct handler call, queue enqueue

## Relationships

- The **Workflow Package** owns **Workflow Definitions**.
- A **Workflow Start** creates or resumes a **Workflow Run**.
- A **Workflow Run** executes one Workflow Definition.
- A **Workflow Run** can contain zero or more **Workflow Steps**.
- A **Workflow Provider** backs Workflow Runs.
- Workflow Provider selection belongs to Integration Options.
- Workflow run ids belong to Invocation Options when supplied at start time.

## Example Dialogue

> **Dev:** "Should a Workflow be modeled as a Queue?"
> **Domain expert:** "No. A Queue delivers jobs. A **Workflow Run** is provider-tracked long-running work with optional **Workflow Steps**."

## Flagged Ambiguities

- Workflow starts and direct handler calls were considered equivalent - resolved: **Workflow Start** means asking the provider to start or resume a run.
- Queue jobs and Workflow Runs were considered interchangeable - resolved: Queue is delivery; Workflow is durable long-running execution.
