---
description: "Find out why the browser fell back to the build catalog after receiving an invalid live catalog."
---

The live catalog route `/_vitehub/i18n/<locale>.json` returned invalid JSON, or its body did not have a string `revision` and valid messages if supplied. The browser logs a warning and uses the build catalog. This warning does not make `setLocale()` return an error.

Open the URL for the affected locale and check that no proxy, middleware, or app route serves a different response at that path.
