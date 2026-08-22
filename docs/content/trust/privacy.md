---
title: ViteHub privacy
description: Understand what the ViteHub documentation site handles and how that differs from applications built with ViteHub.
---

# ViteHub privacy

This notice covers the public documentation site at vitehub.dev. It does not cover applications that developers build with ViteHub. Those applications choose their own hosts, model providers, databases, telemetry, authentication, retention rules, and privacy terms. Installing a ViteHub package does not create a vitehub.dev account or route application data through a shared ViteHub service.

## Data handled by this site

The documentation site does not provide user accounts, checkout, advertising, or a contact form. Like any public website, its hosting and network providers process request information needed to deliver and protect the site. That information can include an IP address, request time, requested URL, user agent, protocol details, and security signals. Operational logs may retain some of that information according to provider configuration and policy.

The site exposes documentation search, raw Markdown, a public MCP endpoint, and other machine-readable resources. Requests to those endpoints are ordinary site requests and can appear in operational logs. Do not send secrets, private source code, personal data, or production credentials in a documentation search or MCP request.

## Local preferences and external sites

The rendered documentation can store interface preferences such as color mode in the browser. Links to GitHub, npm, Discord, deployment providers, and other third-party sites leave vitehub.dev. Those services receive the request and apply their own privacy terms. Review their policies before signing in or sharing information.

## Access and corrections

ViteHub cannot inspect or delete data held by an application that merely uses ViteHub packages. Contact that application's operator for its records. For a question about this documentation site or a correction to this notice, use the [ViteHub contact page](/contact). Report suspected security problems through the private channel listed there rather than placing sensitive details in a public issue.

This notice should be updated whenever vitehub.dev adds accounts, forms, analytics, hosted application processing, or a new data provider. Repository history provides the public record of changes to this page.
