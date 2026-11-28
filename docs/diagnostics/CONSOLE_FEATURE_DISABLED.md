---
description: "Fix CONSOLE_FEATURE_DISABLED in ViteHub when the CLI or the Console calls an operation of a feature that the app does not have."
seo.title: "CONSOLE_FEATURE_DISABLED: the feature is off in the app"
---

The app answers `404` with `CONSOLE_FEATURE_DISABLED` when it knows the operation but does not have the feature that owns it, such as `vitehub agent list` on an app without Agents.

## Why it happens

The CLI and the Console know every operation, but an app serves only the operations of the features that it has. A feature is off when the app has no Definition for it and no key for it in the ViteHub configuration.

## Fix it

Turn the feature on as the `fix` of the error says, then restart the dev server, or build and deploy the app again.
