// @vitest-environment happy-dom
import { flushPromises, mount } from "@vue/test-utils"
import { defineComponent, h, type Component } from "vue"
import { afterEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({ github: false, hasEmail: false }))

vi.mock("../src/console/runtime/client/account", () => ({
  acceptConsoleInvitation: vi.fn(),
  cancelConsoleInvitation: vi.fn(),
  earlyConsoleTeam: { take: () => Promise.resolve({ members: [], invitations: [] }) },
  inviteConsoleMember: vi.fn(),
  linkConsoleGitHub: vi.fn(),
  loadConsoleSignInMethods: () => Promise.resolve({ github: state.github }),
  loadConsoleTeam: () => Promise.resolve({ members: [], invitations: [] }),
  removeConsoleMember: vi.fn(),
  signInWithGitHub: vi.fn(),
  signInWithPasskey: vi.fn(),
  signUpWithPasskey: vi.fn(),
}))
vi.mock("../src/console/runtime/client/toast", () => ({ useConsoleToast: () => ({ show: vi.fn() }) }))
vi.mock("../src/console/runtime/client/project-session", async () => {
  const { shallowRef } = await import("vue")
  const account = () => ({
    hasEmail: state.hasEmail,
    roles: ["owner"],
    teamId: "team",
    teams: [{ id: "team", name: "Ocean" }],
    user: { name: "Owner" },
  })
  return {
    canManageConsoleProjects: () => true,
    consoleSignInReturnPath: () => "/home",
    consoleSiteLink: () => undefined,
    finishConsoleSignIn: vi.fn(),
    reloadConsoleAccount: vi.fn(),
    useConsoleProjects: () => ({ account: shallowRef(account()), pageOrigin: "http://localhost" }),
  }
})

import SignIn from "../src/console/runtime/components/console-account-sign-in.vue"
import Team from "../src/console/runtime/components/console-account-team.vue"

const UButton = defineComponent({ props: { label: String }, setup: props => () => h("button", props.label) })
const stubs = { UButton, UInput: true, USelect: true, USkeleton: true, UAvatar: true, UModal: true, UTooltip: true, Icon: true }

async function render(component: Component, props: Record<string, unknown> = {}) {
  const wrapper = mount(component, { props, global: { stubs } })
  await flushPromises()
  return wrapper
}

afterEach(() => {
  state.github = false
  state.hasEmail = false
})

describe("Invitations on a Console without GitHub sign-in", () => {
  it("does not offer an invite form that nobody can accept", async () => {
    const wrapper = await render(Team)
    expect(wrapper.text()).toContain("this Console has no GitHub sign-in")
    expect(wrapper.text()).toContain("GITHUB_CLIENT_ID")
    expect(wrapper.find("form").exists()).toBe(false)
    wrapper.unmount()
  })

  it("keeps the invite form when the Console has GitHub sign-in", async () => {
    state.github = true
    const wrapper = await render(Team)
    expect(wrapper.find("form").exists()).toBe(true)
    expect(wrapper.text()).toContain("Use their GitHub email.")
    wrapper.unmount()
  })

  it("does not tell a passkey account to connect GitHub", async () => {
    const wrapper = await render(SignIn, { invitation: "invite" })
    expect(wrapper.text()).not.toContain("Connect GitHub")
    expect(wrapper.text()).toContain("this Console has no GitHub sign-in")
    wrapper.unmount()
  })

  it("tells a passkey account to connect GitHub when the Console has it", async () => {
    state.github = true
    const wrapper = await render(SignIn, { invitation: "invite" })
    expect(wrapper.text()).toContain("Connect GitHub")
    wrapper.unmount()
  })
})
