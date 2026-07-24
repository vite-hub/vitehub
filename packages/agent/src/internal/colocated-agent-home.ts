interface EncodedColocatedAgentHomeFile {
  contents: string
  encoding: "base64"
}

export type ColocatedAgentHome = Record<string, { contents: Uint8Array }>

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

export function decodeColocatedAgentHome(
  files: Record<string, EncodedColocatedAgentHomeFile> | undefined,
): ColocatedAgentHome | undefined {
  if (!files) return
  return Object.fromEntries(Object.entries(files).map(([target, file]) => [
    target,
    {
      contents: Uint8Array.from(atob(file.contents), byte => byte.charCodeAt(0)),
    },
  ]))
}

export function withColocatedAgentHome<Agent>(
  agent: Agent,
  files: ColocatedAgentHome | undefined,
): Agent {
  if (!files || !Object.keys(files).length) return agent
  if (!isRecord(agent) || !isRecord(agent.box)) {
    throw new Error("[vitehub] A colocated Agent Home requires defineAgent({ box }).")
  }

  const explicitFiles = isRecord(agent.box.home) && isRecord(agent.box.home.files) ? agent.box.home.files : {}
  const conflict = Object.keys(files).find(target => Object.prototype.hasOwnProperty.call(explicitFiles, target))
  if (conflict) {
    throw new Error(`[vitehub] Colocated Agent Home conflicts with box.home.files: ${conflict}`)
  }

  const box = {
    ...agent.box,
    home: {
      ...(isRecord(agent.box.home) ? agent.box.home : {}),
      files: { ...files, ...explicitFiles },
    },
  }
  const descriptors = Object.getOwnPropertyDescriptors(agent) as Record<string | symbol, PropertyDescriptor>
  const boxDescriptor = descriptors.box
  descriptors.box = boxDescriptor && "value" in boxDescriptor
    ? { ...boxDescriptor, value: box }
    : { configurable: true, enumerable: true, value: box, writable: true }

  const workspaceOptionsDescriptor = descriptors.__vitehubWorkspaceAgentOptions
  const workspaceOptions = workspaceOptionsDescriptor
    && "value" in workspaceOptionsDescriptor
    && isRecord(workspaceOptionsDescriptor.value)
    ? workspaceOptionsDescriptor.value
    : undefined
  if (workspaceOptions) {
    descriptors.__vitehubWorkspaceAgentOptions = {
      ...workspaceOptionsDescriptor,
      value: { ...workspaceOptions, box },
    }
  }

  const settingsDescriptor = descriptors.__vitehubAgentSettings
  const settings = settingsDescriptor && "value" in settingsDescriptor && isRecord(settingsDescriptor.value)
    ? settingsDescriptor.value
    : workspaceOptions
  if (settings) {
    descriptors.__vitehubAgentSettings = settingsDescriptor && "value" in settingsDescriptor
      ? { ...settingsDescriptor, value: { ...settings, box } }
      : { configurable: false, enumerable: false, value: { ...settings, box }, writable: false }
  }

  return Object.create(Object.getPrototypeOf(agent), descriptors)
}
