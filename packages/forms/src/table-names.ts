/**
 * The schema keys of `formsSchema` and their SQL names. Its own module, so the Vite plugin lists the tables without
 * loading Drizzle during config resolution.
 */
export const formsTableNames: Readonly<Record<string, string>> = { formSubmissions: "vitehub_form_submissions" }
