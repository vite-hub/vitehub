# Queue Package

Queue Package names ownership boundaries for `@vite-hub/queue`.

## Language

**Queue Package**:
The package that owns queue Definitions, queue delivery, and provider-neutral enqueue behavior.
_Avoid_: Job runner package, workflow package

**Queue Definition**:
A portable handler declaration for background jobs delivered through a Queue Provider.
_Avoid_: Callback route, provider consumer

**Queue Job**:
The normalized job payload and metadata delivered to a Queue Definition.
_Avoid_: Provider message, event

**Queue Provider**:
The backend that accepts and delivers queued jobs.
_Avoid_: Queue definition, runtime helper

**Queue Delivery**:
The provider-triggered runtime flow that invokes a Queue Definition with a Queue Job.
_Avoid_: Enqueue, workflow step

**Queue Enqueue**:
The runtime action of sending a job to a Queue Provider.
_Avoid_: Queue delivery, direct handler call

## Relationships

- The **Queue Package** owns **Queue Definitions**.
- A **Queue Provider** delivers **Queue Jobs**.
- **Queue Delivery** invokes a Queue Definition.
- **Queue Enqueue** sends work to a Queue Provider.
- Queue Provider selection belongs to Integration Options.
- Queue delay, region, retention, and idempotency belong to Invocation Options when supplied per enqueue.

## Example Dialogue

> **Dev:** "Should `runQueue()` return the queue handler result?"
> **Domain expert:** "No. **Queue Enqueue** means the provider accepted the job. The handler result belongs to **Queue Delivery**."

## Flagged Ambiguities

- Queue enqueue and provider delivery were considered one lifecycle - resolved: use **Queue Enqueue** for sending and **Queue Delivery** for handler invocation.
- Provider messages were considered the public job shape - resolved: the public handler receives a **Queue Job**.
