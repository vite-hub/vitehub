---
description: "Retry a translation save after another save changes the Workspace draft."
---

Another save changed the Workspace `draft` ref while `useTranslations().save()` was writing the translation. Your translation was not saved. The returned error has status `409`, and `error.cause` holds the Workspace conflict.

Call `save()` again so it reads the new draft before writing the translation.
