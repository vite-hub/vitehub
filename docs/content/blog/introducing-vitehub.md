---
title: Introducing ViteHub
description: >-
  Provider-agnostic server primitives for Vite, Nitro, and the next generation
  of Nuxt apps.
date: 2026-05-28
category: Article
image: /images/tutorials/vitehub-intro-flat.png
authors:
  - name: onmax
    avatar:
      src: https://github.com/onmax.png
    to: https://github.com/onmax
icon: i-lucide-network
---

JavaScript makes frontend work feel fast, typed, and composed. Then you add
storage, queues, scheduled jobs, workflows, or AI agents, and the server side
often pulls you back into provider wiring.

ViteHub starts from that frustration.

The goal is to make server features feel like the best parts of the Nuxt
ecosystem: good defaults, clear files, typed APIs, and enough escape hatches to
use the platform underneath. You choose the provider in configuration. Your
application code stays focused on the product.

ViteHub starts with Vite and Nitro v3 because the Vite Environment API opens a
new way to build server features. My long-term goal is to bring this foundation
into Nuxt 5, so the same provider-agnostic primitives can become normal Nuxt
developer experience.

## The problem

JavaScript has excellent tools for building the user-facing part of an app.
Vite, Nuxt, and the surrounding ecosystem give you fast feedback loops, strong
conventions, and a clear way to compose features.

Server work still feels more fragmented. Uploads, key-value state, databases,
queues, workflows, scheduled jobs, sandboxes, and AI agents often begin with a
provider SDK. That works, but it also spreads infrastructure details across
routes, handlers, and tests.

The cost shows up later. Local development becomes harder to trust. Moving from
one provider to another means touching product code. Small features carry more
setup than they should.

## The idea

ViteHub moves provider wiring to the framework boundary.

With ViteHub, the shape is:

- define the server feature in a small file
- register the Vite plugin or Nitro module
- choose the provider in configuration
- call the typed API from application code
- inspect the behavior locally before deploying

Provider-agnostic does not mean lowest common denominator. Cloudflare, Vercel,
and local development are not the same environment. ViteHub keeps those
differences available in configuration, while keeping ordinary product code
away from provider-specific setup.

The result is less ceremony. You can switch providers without rewriting the
feature, but you can still reach for the provider features that matter.

## The projects that shaped it

ViteHub follows ideas I already trust.

[Nuxt Hub](https://hub.nuxt.com/) showed how full-stack features can feel
native to a framework without hiding storage, deployment, and runtime details.
[UnJS](https://unjs.io/) shaped the package design: small libraries, portable
runtime pieces, and clear boundaries instead of one giant runtime.

[Better Auth](https://better-auth.com/) inspired the agent API. It has a
developer experience I care about: one typed file, composable plugins, and a
configuration surface that grows with the application instead of taking over
the codebase.

Laravel is another reference point. The JavaScript ecosystem has incredible
frontend tools, but server features still need more consistency. ViteHub is one
step toward that: a server layer that feels coherent without locking you into
one host.

## The first layer: server primitives

The first layer is a set of primitives for product infrastructure:

- Env for typed configuration
- KV for key-value state
- Blob for file-shaped data
- DB for database access
- Queue for background work
- Workflow for durable orchestration
- Schedule for cron work
- Sandbox for isolated execution
- Workspace for persistent file-tree state and source ingestion

Each primitive owns one job. The framework integration discovers the files it
needs, prepares the provider output, and exposes a small runtime API for your
app.

You should not need thousands of lines of setup to add a queue or a workflow.
The product code should say what happens. The framework config should say where
it runs.

## The second layer: agents

The agent package builds on top of those primitives.

An agent has three parts:

- Agent for the model behavior and instructions
- Capabilities for the explicit actions it can take
- Workspace for the source, files, and project context it can inspect

This keeps the agent understandable. You can open one file and see what the
agent is allowed to do, which model behavior it follows, and which workspace
context it receives.

The API is intentionally small. Add the capabilities you need. Leave the rest
out. The agent grows with the product instead of starting as a large framework.

## The developer experience

ViteHub is designed to remove the boring work without removing control.

You get sensible defaults for local development. You keep provider choice in
configuration. You can review a feature by opening a few files instead of
chasing setup across the codebase.

The important part is not the architecture diagram. The important part is what
it removes from your day: duplicated provider setup, fragile local mocks,
runtime configuration spread across handlers, and migration work that touches
business logic.

Good API design matters here. The primitives need to feel small, but not
limited. They need to hide the repetitive wiring, but not the platform power.

## Where it is going

ViteHub is still early, and that is why I want to share it now. The foundation
is useful enough to build with, but there is a lot of work ahead:

- more provider coverage
- stronger tests across Vite, Nitro, Cloudflare, and Vercel
- better examples for real product flows

The next post goes deeper into the first layer: server primitives for any host.
After that, we will use those ideas to build an AI agent in one file.
