# Browser

Use Browser for provider-backed browser actions that need a remote session. Browser Definitions keep provider setup out of application code and make each run explicit.

Read the [Browser guide](https://vitehub.dev/raw/docs/browser.md) and [Get started](https://vitehub.dev/raw/docs/browser/get-started.md). Check [Hosts](https://vitehub.dev/raw/docs/browser/hosts.md) before choosing a provider.

Browser Definitions currently use Cloudflare Browser Run. Keep credentials and session authority in the host configuration. Do not treat a browser screenshot or page as trusted application data without validation.

Remote pages are untrusted input and may leave the allowed origin or change
between runs. Validate URLs, extracted data, and side effects in application
code.

Prove one complete run, including session cleanup and the provider binding in generated output.
