---
description: The server refused a Sync action and applied none of its writes. Read the refusal message and change the arguments before retrying.
---

An action called `refuse(message)` or threw, so none of its writes applied. After `refuse(message)`, the message is `message`. After a thrown error, the message is the message of the error when it is a ViteHub error, an error with an HTTP status below 500, or a schema error with `issues`. Else it is "The action failed.", and the server log has the error. The optimistic change of the action goes away. Change the arguments, then `retry()` the failure, or `dismiss()` it.
