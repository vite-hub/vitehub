---
title: Schedule boundaries
description: Current limits for Runtime Schedules, the Basic Self-Hosted Schedule Runner, and production provider behavior.
navigation.title: Boundaries
navigation.order: 5
icon: i-lucide-circle-slash
frameworks: [vite, nitro]
---

Schedule currently provides definitions, Runtime Schedule records, run bookkeeping, and a Basic Self-Hosted Schedule Runner. It does not provide a production distributed scheduler.

## Current runner boundary

The Basic Self-Hosted Schedule Runner is intentionally small:

- It scans one configured Runtime Schedule store.
- It matches enabled records against the current UTC minute.
- It dispatches due Runtime Schedules in the current process.
- It records runs and attempts in the configured Schedule Run store.
- It bounds local concurrency with the `concurrency` option.
- It isolates scan and handler failures so future scans can continue.

Use [Basic Self-Hosted Schedule Runner](./runner) for startup examples and exact behavior.

## Single active runner per store

Only one active runner should use a given Runtime Schedule store and Schedule Run store at a time.

The runner checks for an existing run record before dispatching, but it does not claim the scheduled minute atomically across processes. Multiple active runners can race.

## UTC minute matching, no backfill

Runtime Schedule cron expressions are five-field UTC cron expressions.

The runner floors `now()` to the current UTC minute during each scan. It does not calculate all missed occurrences between scans and it does not backfill after downtime.

## Failure behavior

A handler failure marks the run and attempt as `failed`. The runner reports the error through `onError` when provided and continues later scans.

The current runner does not retry failed Runtime Schedule runs. Add retry behavior inside the target handler or use another execution primitive if retry semantics are required.

## Out of scope

These are intentionally not part of the current Schedule package behavior:

- BullMQ or another queue-backed scheduler.
- Distributed claiming, leases, leader election, or cross-process locking.
- Docker Compose templates for a schedule runner service.
- systemd unit generation.
- cron file generation.
- Production self-hosted provider behavior.

Those features may become separate provider or deployment work later, but the current package docs and API describe only the basic self-hosted runner.
