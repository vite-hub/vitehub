---
title: Built for the Vue ecosystem
description: ViteHub is a server primitive library with a Vue and Nuxt point of view.
navigation.title: Built for the Vue ecosystem
navigation.order: 1.5
navigation.group: Perspective
icon: i-simple-icons-vuedotjs
---

ViteHub is a server primitive library. It gives a Vite application durable building blocks for Agents, storage, workspaces, queues, and the rest of the work that sits behind a product. The code that calls those primitives stays in your application.

I am building it for the Vue ecosystem because that is where I spend my time. I am Maxi, and I use Nuxt and Vue for the products I want to ship. Nuxt makes the application boundary clear, Vue makes the UI pleasant to shape, and Vite keeps the development loop short. ViteHub should feel native in that stack.

The UI package follows the same choice. React has many strong component libraries and a wide range of session, Agent, and chat projects. ViteHub UI is the Vue answer for the first ViteHub use case: the Console. The default chat, session, invocation, trace, diff, and file components should drop into a Nuxt app and look right before you add a line of custom CSS.

That means fewer knobs and better starting points. Components own the spacing, empty states, focus behavior, and dense layouts that a Console needs. You can still replace a slot when your product needs a different decision, but the common path should stay small.

If you are new to ViteHub, start with [the first Agent](/docs/getting-started/first-agent), then see [the UI installation](/docs/ui/installation) and [the Console blocks](/docs/ui/blocks/chat-app).
