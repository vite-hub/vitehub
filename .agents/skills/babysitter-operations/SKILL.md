---
name: babysitter-operations
description: Diagnoses and verifies ViteHub Babysitter service health, throughput, restarts, and deployments. Use when Babysitter appears idle, stalled, unhealthy, under capacity, or needs an explicitly requested restart or deployment.
---

# Babysitter operations

Measure pull-request progress, not process activity.

## Baseline

Read the repository instructions and operational README section. Capture the service PID and restart count, `/api/health`, current invocations, recent terminal events, open pull-request gate states, GitHub budget, and host prerequisites once.

Classify the stall before changing capacity:

- No selected work: inspect discovery, fingerprints, working reservations, GitHub budget, and stack-parent filtering.
- Repeated unchanged passes: compare exact-head required checks, reviews, comments, and Pullfrog evidence. Leave known pending gates to the scheduler.
- Failed or missing owners: inspect terminal errors, provider cleanup, timeouts, memory pressure, and stale active records.
- Owners without merges: count unique pull requests repaired, merged, or closed. Completed invocations alone do not prove progress.

After the baseline, query only changed or owned pull requests. Sample on state transitions or at the repair interval. Two healthy wake-and-complete cycles prove continuity unless the user requests a longer watch.

## Restart or deploy

A request to diagnose does not authorize a restart or deployment. When the user explicitly requests one, let active owners drain unless the service is unhealthy. Record the old PID, issue one restart, and wait on that request.

Before deployment, build and test the exact commit. Run the service pre-start check against the systemd unit and drop-in paths it will actually load. Update one canonical release target, reload once, and start once. If pre-start fails, inspect that gate before changing another unit file.

Recovery is complete when the running commit is correct, health is good, discovery selects expected changed work, one pull request advances or an owner reaches a justified terminal gate, and no active invocation predates the service process.
