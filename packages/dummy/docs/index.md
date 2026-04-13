---
title: Dummy
description: Minimal package docs for validating framework-aware routes and content blocks.
navigation.title: Overview
icon: i-lucide-box
---

`@vitehub/dummy` is the smallest package in the repo. It exists to prove the docs system, not to describe a real API surface.

The framework switcher in the sidebar rewrites this page, so the overview only needs to point at the active runtime entry.

::fw{id="vite:dev vite:build"}

Use the Vite plugin flow for this package.

::

::fw{id="nitro:dev nitro:build"}

Use the Nitro server runtime flow for this package.

::

::fw{id="nuxt:dev nuxt:build"}

Use the Nuxt module flow for this package.

::

Examples live under `examples/{framework}/`.
