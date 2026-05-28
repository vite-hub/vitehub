---
title: Blogs
description: Learn why ViteHub exists, how the server primitives fit together, and how the Agent layer builds on top.
navigation.title: Blogs
icon: i-lucide-graduation-cap
frameworks: [vite, nitro]
---

These posts introduce ViteHub from the bottom up: the project direction, the
server primitive layer, and the Agent layer.

::u-blog-posts{orientation="vertical" class="not-prose mt-8 max-w-5xl pb-2"}
  :::u-blog-post{orientation="horizontal"}
  ---
  title: Introducing ViteHub
  description: Server primitives for Vite and Nitro apps with good defaults, typed APIs, and provider choice.
  image: /images/tutorials/vitehub-intro-flat.png
  badge:
    label: Overview
    color: primary
    variant: soft
  variant: subtle
  to: ./introducing-vitehub
  ui:
    root: "overflow-hidden"
    header: "aspect-[16/9]"
    body: "p-5 sm:p-6 lg:px-0"
    image: "object-cover object-center"
  ---
  :::
  :::u-blog-post{orientation="horizontal"}
  ---
  title: Server primitives for any host
  description: Use storage, background work, workflows, schedules, sandbox execution, and workspace state without locking application code to one provider.
  image: /images/tutorials/server-primitives-flat.png
  badge:
    label: Tutorial
    color: primary
    variant: soft
  variant: subtle
  to: ./server-primitives-any-host
  ui:
    root: "overflow-hidden"
    header: "aspect-[16/9]"
    body: "p-5 sm:p-6 lg:px-0"
    image: "object-cover object-center"
  ---
  :::
  :::u-blog-post{orientation="horizontal"}
  ---
  title: Build an AI Agent in one file
  description: Build a support Agent with model behavior, Capabilities, Workspace Sources, DevTools, and an Agent Eval.
  image: /images/tutorials/agent-layers-flat.png
  badge:
    label: Tutorial
    color: primary
    variant: soft
  variant: subtle
  to: ./build-ai-chatbot
  ui:
    root: "overflow-hidden"
    header: "aspect-[16/9]"
    body: "p-5 sm:p-6 lg:px-0"
    image: "object-cover object-center"
  ---
  :::
::
