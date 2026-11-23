---
description: Fix a missing Email driver module by checking the path relative to your project root and creating the module if needed.
---

`email.driver` is the path of a driver module, but no file is at that path. The path is relative to the project root, not to the config file. A path without an extension also finds a `.ts`, `.mts`, `.js`, or `.mjs` file.

Create the module, or fix the path. The module default-exports a function that gets `email.options` and returns an `EmailDriver`. See [Configure another provider](/docs/email/configure#configure-another-provider).
