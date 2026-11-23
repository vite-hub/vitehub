The `smtp` Email driver sends with [Nodemailer](https://nodemailer.com), and the app does not have the `nodemailer` package. ViteHub does not install it for you, and it imports it only when it sends.

Install it in the app, for example `pnpm add nodemailer`. The build checks this, so `vite build` stops with this code. A `createEmail()` client with the `smtp` driver throws this code on its first send. See [Send over SMTP](/docs/email/configure#send-over-smtp).
