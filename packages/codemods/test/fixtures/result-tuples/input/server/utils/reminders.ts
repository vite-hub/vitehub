import { createWorkflow } from "vite-hub/workflow";

const reminders = createWorkflow<{ email: string }>("send-reminder");

export async function remind(email: string) {
  const run = await reminders.start({ email });
  const current = await reminders.getRun(run.id);
  return current.status;
}

// Not async: the codemod cannot add `await`, so the report lists it.
export function remindLater(email: string) {
  return reminders.start({ email }, { delay: "1 day" });
}

export async function remindAll(emails: string[]) {
  return Promise.all(emails.map(email => reminders.start({ email })));
}
