import { expectTypeOf, it } from "vitest"

import type { DeliverChannelOptions as AgentDeliverChannelOptions, deliverChannel } from "@vite-hub/agent/test"
import type { EmailMessage } from "@vite-hub/email"
import type { ScheduleDefinition, ScheduleRunRecord } from "@vite-hub/schedule"
import type { DeliverChannelOptions, ViteHubTest } from "../src/test.ts"

it("keeps local test shapes compatible with their optional Primitive owners", () => {
  expectTypeOf<DeliverChannelOptions>().toEqualTypeOf<AgentDeliverChannelOptions>()
  expectTypeOf<ViteHubTest["emails"][number]>().toEqualTypeOf<EmailMessage>()
  expectTypeOf<Parameters<typeof deliverChannel>>().toExtend<Parameters<ViteHubTest["deliverChannel"]>>()
  expectTypeOf<Parameters<ViteHubTest["runSchedule"]>[0]>().toExtend<ScheduleDefinition>()
  expectTypeOf<ScheduleDefinition>().toExtend<Parameters<ViteHubTest["runSchedule"]>[0]>()
  expectTypeOf<Awaited<ReturnType<ViteHubTest["runSchedule"]>>>().toEqualTypeOf<ScheduleRunRecord>()
})
