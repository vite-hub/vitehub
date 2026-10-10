---
title: Sandbox concepts
description: Understand the boundary between a Sandbox definition, its provider runtime, and the application that starts it.
navigation.title: Concepts
navigation.order: 3
navigation.group: Concepts
icon: i-lucide-lightbulb
---

A Sandbox runs a named package project away from the application process. The
application chooses the provider in Vite configuration. The Definition stays
portable and the provider supplies the isolation, filesystem, network, and
process limits.

## A run has two sides

The application calls `runSandbox(name, payload, options)` and receives a
native `Response`. The named project receives the payload inside its own
entrypoint. Keep request validation and user authentication in the application,
then pass only the data the isolated project needs.

The response reports the run outcome. A successful HTTP response means the
entrypoint returned a response. It does not grant the Sandbox access to the
application's filesystem or credentials.

## Provider choice changes the boundary

Cloudflare Sandbox and Vercel Sandbox implement the same package contract, but
they do not expose identical limits or local development behavior. Choose the
provider in [Hosts](/docs/sandbox/hosts), then verify the generated output with
the ViteHub CLI before deployment.

Read [Sandbox configuration](/docs/sandbox/configure) for package layout and
runtime options. Read [Limits and errors](/docs/sandbox/limits-and-errors)
before accepting untrusted input.
