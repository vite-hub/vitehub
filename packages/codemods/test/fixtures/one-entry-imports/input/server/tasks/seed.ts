import { defineTask, type TaskEvent, TaskResult } from "vite-hub/task"

export default defineTask({
  meta: { description: "Add demo rows" },
  async run(event: TaskEvent): Promise<TaskResult> {
    return { result: event.payload }
  },
})
