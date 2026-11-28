---
description: "Fix CONSOLE_FEATURE_DISABLED in ViteHub when the CLI or the Console calls an operation of a feature that the app does not have."
seo.title: "CONSOLE_FEATURE_DISABLED: the feature is off"
---

The app answers `404` with `CONSOLE_FEATURE_DISABLED` when it knows the operation but does not have the feature that owns it, such as `vitehub agent list` on an app without Agents.

## Why it happens

ViteHub recognizes the operation, but the app does not serve it. A feature can be off because its Definition is missing or because its configuration does not turn it on.

## Fix it

Turn the feature on as the `fix` of the error says, then restart the dev server, or build and deploy the app again.
