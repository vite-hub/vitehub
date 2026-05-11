---
title: Blogs
description: Build complete ViteHub features from chat interfaces, sources, agents, and hosted runtimes.
navigation.title: Blogs
icon: i-lucide-graduation-cap
frameworks: [vite, nitro]
---

Blogs show how ViteHub primitives fit together in real applications. Start here when you want an end-to-end feature instead of a single package reference.

::u-blog-posts{orientation="vertical" class="not-prose mt-8 max-w-5xl pb-2"}
  :::u-blog-post{orientation="horizontal"}
  ---
  title: Build a Source-Aware Chatbot
  description: Connect chat providers, workspace sources, and a colocated Agent that can run across ViteHub runtimes.
  image: /images/tutorials/source-aware-chatbot.png
  badge:
    label: Tutorial
    color: primary
    variant: soft
  variant: subtle
  to: ./source-aware-chatbot
  ui:
    root: "overflow-hidden"
    header: "aspect-[16/9]"
    body: "p-5 sm:p-6 lg:px-0"
    image: "object-cover object-center"
  ---
  :::
::
