---
title: Sandbox concepts
description: How a Sandbox Task, its provider, and the app that starts it fit together.
navigation.title: Concepts
navigation.order: 9
navigation.group: Concepts
icon: i-lucide-lightbulb
---

A Sandbox Task runs a named package in a Sandbox, away from your app process. The app chooses the provider in Vite config. The task code stays portable. The provider supplies the isolation, filesystem, network, and process limits.

## A run has two sides

The app calls `runSandboxTask(name, payload, options)` and gets a native `Response`. The task gets the payload in its entry point. Validate requests and authenticate users in the app. Pass only the data the task needs.

The response reports the run outcome. A success status means the entry point returned. It does not give the Sandbox access to your app's filesystem or credentials.

## Provider choice changes the boundary

Cloudflare Sandbox and Vercel Sandbox run the same packages, but their limits and local development differ. Choose the provider in [Hosts](/docs/sandbox/hosts). Check the generated output with the ViteHub CLI before you deploy.

Read [Sandbox Task configuration](/docs/sandbox/configure) for package layout and options. Read [Limits and errors](/docs/sandbox/limits-and-errors) before you accept untrusted input.
