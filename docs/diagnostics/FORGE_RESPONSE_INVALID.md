A Forge response contains missing or invalid data. For example, `forgeBlob()` raises this error if GitHub returns blob content that is not valid Base64.

## How to fix it

Read the error message first: it describes the specific problem. If the message points to missing data for a resource, check that the GitHub App, token, or Forge webhook can read that resource before retrying.
