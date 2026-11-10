---
title: ViteHub privacy
description: What data the ViteHub docs site handles, and how that differs from apps built with ViteHub.
---

This notice covers the public docs site at vitehub.dev. It does not cover apps that developers build with ViteHub. Those apps choose their own hosts, model providers, databases, telemetry, authentication, retention rules, and privacy terms. Installing a ViteHub package creates no vitehub.dev account and sends no app data through a shared ViteHub service.

## Data handled by this site

The docs site has no user accounts, checkout, advertising, or contact form. Like any public website, its hosting and network providers process request data to deliver and protect the site: IP address, request time, URL, user agent, protocol details, and security signals. Provider logs may keep some of it, by provider config and policy.

The site offers docs search, raw Markdown, a public MCP endpoint, and other machine-readable resources. These are normal site requests and can appear in logs. Do not send secrets, private source code, personal data, or production credentials in a search or MCP request.

## Local preferences and external sites

The docs can store interface settings, such as color mode, in your browser. Links to GitHub, npm, Discord, hosting providers, and other third-party sites leave vitehub.dev. Those services get your request and apply their own privacy terms. Read their policies before you sign in or share data.

## Access and corrections

ViteHub cannot see or delete data held by an app that uses ViteHub packages. Ask that app's operator for its records. For questions about this site or fixes to this notice, use the [ViteHub contact page](/contact). Report security problems through the private channel listed there, not in a public issue.

Update this notice when vitehub.dev adds accounts, forms, analytics, hosted app processing, or a new data provider. The repository history is the public record of changes to this page.
