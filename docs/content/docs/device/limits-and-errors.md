---
title: Device limits and errors
description: What stored reads do not protect, the fixed limits of the device, and the DEVICE error codes.
navigation.title: Limits and errors
navigation.order: 7
icon: i-lucide-circle-alert
---

## What a stored copy is not

- **Not confidential.** IndexedDB is not encrypted for your app. Anyone who can use the browser profile, browser extensions, and malware on the computer can read the copies. Do not store secrets, tokens, or data that must not stay on the device.
- **Not private on a shared computer.** When the next person opens the app, the first render shows the copies of the last account. They go away when your app calls `setDeviceAccount()` with the new account. Call `setDeviceAccount(null)` on a sign-out, so the copies go at that time.
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

## Not in the device yet

- **Values between tabs.** `clearDevice()` and a change of account reach every tab. A new answer does not: each tab asks its own loader.
- **Refresh on focus or online.** A read calls its loader when it starts and when you call `refresh()`.
- **Writes.** There is no outbox and no optimistic write. A stored read only keeps what the server answered.
- **Nuxt auto-import.** Import `useStoredData()` from `vite-hub/device/vue`.
- **Encryption and more than one account.**

## Errors

`setDeviceAccount()` and `clearDevice()` return `[error, undefined]`. Wrong input throws. The device prints the other codes once in the browser console, and the read goes on.

### DEVICE_STORAGE_FAILED

IndexedDB failed to change the stored copies, such as when the disk is full. `setDeviceAccount()` and `clearDevice()` return it. A failed write of a copy prints it once. Call the function again. If it fails again, ask the user to clear the site data in the browser settings.

### DEVICE_INVALID_ACCOUNT

`setDeviceAccount()` got an empty string or a value that is not a string or `null`. Pass the user id from your session.

### DEVICE_INVALID_KEY

`useStoredData()` got a key that is not a string, or an empty string. Give each read a key that names its data.

### DEVICE_INVALID_MAX_AGE

`maxAge` is not a number of milliseconds that is 0 or more.

### DEVICE_ALREADY_OPEN

`openDevice()` ran again with another `version`. Call it once, before the app mounts.

### DEVICE_NOT_OPEN

A read stored an answer, and the app never called `openDevice()`. The answer stays in memory, so a reload shows the default. Call `await openDevice()` before `app.mount()`.

### DEVICE_VALUE_NOT_JSON

The loader returned a value that JSON cannot store, such as an object that contains itself. Return plain data.

### DEVICE_VALUE_TOO_LARGE

One answer is larger than 5 MB as JSON. Load less, such as one page of a list.
