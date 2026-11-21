---
title: Device limits and errors
description: What stored reads do not protect, the fixed limits of the device, and the DEVICE error codes.
navigation.title: Limits and errors
navigation.order: 7
icon: i-lucide-circle-alert
---

## What a stored copy is not

- **Not confidential.** IndexedDB is not encrypted for your app. Anyone who can use the browser profile, browser extensions, and malware on the computer can read the copies. Do not store secrets, tokens, or data that must not stay on the device.
- **Not private on a shared computer.** When the next person opens the app, the first render shows the copies of the last account. They go away when your app calls `setDeviceAccount()` with the new account. Call `setDeviceAccount(null)` on a sign-out, so the copies go at that time. With ViteHub Auth in Nuxt, the module does both.
- **Not access.** A stored copy only changes what the screen shows first. Your server still checks every request, and the loader asks it each time.

## Limits

| Limit | Value |
| --- | --- |
| Accounts | One. Another account deletes the copies of the previous one. |
| Size | 5 MB of JSON for all tabs together. When a new copy goes over, the oldest copies on the disk go first, also copies of other tabs. A single answer over 5 MB is not kept. |
| Age | A copy older than `maxAge` (7 days by default) does not show. The disk deletes it at the next `openDevice()` or write. |
| Wait for IndexedDB | 1 second in `openDevice()`. A page that waited longer keeps its copies in memory. |
| Time to open | 1 to 3 ms for one copy, and 8 to 15 ms for 5 MB, in headless Chromium on a desktop computer. |
| Values | JSON only. A `Date` becomes a string, and a value that JSON cannot store is not kept. |
| Builds | One `version`. A tab takes the disk for its version when it opens. When a tab of a newer build takes it later for the same account, the older tab stores nothing until it loads again. Another account always empties the disk. |

## Not in the device yet

- **Values between tabs.** `clearDevice()` and a change of account reach every tab. A new answer does not: each tab asks its own loader.
- **Refresh on focus or online.** A read calls its loader when it starts and when you call `refresh()`.
- **Writes.** There is no outbox and no optimistic write. A stored read only keeps what the server answered.
- **Other requests in `useStoredFetch()`.** It sends a GET for JSON only. Use `useStoredData()` with your own loader for another method, a body, or a `transform`.
- **Server reads in Nuxt.** The server renders the default. The stored copy shows when hydration ends.
- **Encryption and more than one account.**

## Errors

`setDeviceAccount()` and `clearDevice()` return `[error, undefined]`. Wrong input throws. A `useStoredFetch()` answer that is not 2xx goes to `error` as `DEVICE_FETCH_FAILED`. The device prints the other codes once in the browser console, and the read goes on.

See the [Device diagnostics](/docs/device/diagnostics) for each code, why it happens, and how to fix it.
