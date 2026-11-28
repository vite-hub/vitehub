## How to fix it

- If the error names `basePath`, set it to a pathname with a route segment and no query or fragment, such as `basePath: '/_vitehub/connections'`.
- If the error names `activityRetention`, use positive integers for `maxAgeMs` and `maxRecords`, such as `activityRetention: { maxAgeMs: 1_209_600_000, maxRecords: 10_000 }`. Set `activityRetention: false` to keep all activity.
- If the error names `connections.database`, set it to the name of a Database that the app defines, such as `database: 'default'`.
