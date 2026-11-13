// Measures what the headless parts cost an app with Reka UI and with ui-sdk, and applies the go or no-go gate for the
// move to ui-sdk (W0.2 of the ViteHub UI plan).
//
//   node scripts/headless-weight.ts          (from packages/ui, or `pnpm run bench:headless`)
//
// It installs the pinned engines below into a folder in `os.tmpdir()` with `pnpm add --ignore-workspace`, so the
// workspace lockfile does not change, and reuses that folder on the next run. For each engine and component, it writes
// a Vue single-file component that mounts the component's main parts, and builds it with Vite as an app entry,
// minified, with Vue external. A row is the gzip size (level 9) of the chunks that the entry loads up front: the entry
// chunk and every chunk that it imports statically. Chunks that load with `import()` are in the lazy column and do not
// count for the gate.
//
// The gate rule was fixed before the first measurement. NO-GO when either is true:
//   1. The median ratio ui-sdk / Reka across the 9 components is above 2.0.
//   2. Tabs, Collapsible, Toast, and Dialog in one entry with both engines cost more than 60 kB (60,000 bytes) gzip
//      over the same entry with Reka alone. That is the interim state until the Nuxt UI exit removes Reka.
// The exit status is 0 for GO and 1 for NO-GO.
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { gzipSync } from "node:zlib"

import vue from "@vitejs/plugin-vue"
import { build } from "vite"
import type { Rolldown } from "vite"

const engines = {
  "reka-ui": "2.11.0",
  "@ui-sdk/vue": "0.1.0-beta.2",
  "@ui-sdk/core": "0.1.0-beta.2",
  vue: "3.5.44",
}
const maxMedianRatio = 2
const maxInterimExtraBytes = 60_000

type Engine = "reka" | "ui-sdk"

interface Sample {
  imports: Record<string, string[]>
  script?: string
  template: string
}

interface Component {
  name: string
  reka: Sample
  "ui-sdk": Sample
}

const components: Component[] = [
  {
    name: "Tabs",
    reka: {
      imports: { "reka-ui": ["TabsContent", "TabsList", "TabsRoot", "TabsTrigger"] },
      template: `<TabsRoot default-value="account">
  <TabsList aria-label="Settings">
    <TabsTrigger value="account">Account</TabsTrigger>
    <TabsTrigger value="password">Password</TabsTrigger>
  </TabsList>
  <TabsContent value="account">Manage your profile.</TabsContent>
  <TabsContent value="password">Choose a new password.</TabsContent>
</TabsRoot>`,
    },
    "ui-sdk": {
      imports: { "@ui-sdk/vue/tabs": ["Tabs", "TabsList", "TabsPanel", "TabsTab"] },
      template: `<Tabs default-value="account">
  <TabsList aria-label="Settings">
    <TabsTab value="account">Account</TabsTab>
    <TabsTab value="password">Password</TabsTab>
  </TabsList>
  <TabsPanel value="account">Manage your profile.</TabsPanel>
  <TabsPanel value="password">Choose a new password.</TabsPanel>
</Tabs>`,
    },
  },
  {
    name: "Collapsible",
    reka: {
      imports: { "reka-ui": ["CollapsibleContent", "CollapsibleRoot", "CollapsibleTrigger"] },
      template: `<CollapsibleRoot>
  <CollapsibleTrigger>Order details</CollapsibleTrigger>
  <CollapsibleContent>2 x Linen shirt</CollapsibleContent>
</CollapsibleRoot>`,
    },
    "ui-sdk": {
      imports: { "@ui-sdk/vue/collapsible": ["Collapsible", "CollapsiblePanel", "CollapsibleTrigger"] },
      template: `<Collapsible>
  <CollapsibleTrigger>Order details</CollapsibleTrigger>
  <CollapsiblePanel>2 x Linen shirt</CollapsiblePanel>
</Collapsible>`,
    },
  },
  {
    name: "Toast",
    reka: {
      imports: {
        "reka-ui": ["ToastAction", "ToastClose", "ToastDescription", "ToastProvider", "ToastRoot", "ToastTitle", "ToastViewport"],
        vue: ["ref"],
      },
      script: "const toastOpen = ref(false)",
      template: `<ToastProvider>
  <button type="button" @click="toastOpen = true">Create event</button>
  <ToastRoot v-model:open="toastOpen">
    <ToastTitle>Event created</ToastTitle>
    <ToastDescription>Friday at 10:00 AM</ToastDescription>
    <ToastAction alt-text="Undo">Undo</ToastAction>
    <ToastClose>Dismiss</ToastClose>
  </ToastRoot>
  <ToastViewport />
</ToastProvider>`,
    },
    "ui-sdk": {
      imports: { "@ui-sdk/vue/toast": ["Toast", "ToastAction", "ToastClose", "ToastDescription", "ToastRegion", "ToastTitle", "toast"] },
      template: `<button type="button" @click="toast('Event created', { description: 'Friday at 10:00 AM', action: { label: 'Undo', onAction: () => {} } })">Create event</button>
<ToastRegion>
  <Toast>
    <ToastTitle />
    <ToastDescription />
    <ToastAction />
    <ToastClose>Dismiss</ToastClose>
  </Toast>
</ToastRegion>`,
    },
  },
  {
    name: "Dialog",
    reka: {
      imports: {
        "reka-ui": ["DialogClose", "DialogContent", "DialogDescription", "DialogOverlay", "DialogPortal", "DialogRoot", "DialogTitle", "DialogTrigger"],
      },
      template: `<DialogRoot>
  <DialogTrigger>Open</DialogTrigger>
  <DialogPortal>
    <DialogOverlay />
    <DialogContent>
      <DialogTitle>Project details</DialogTitle>
      <DialogDescription>Review the details before you continue.</DialogDescription>
      <DialogClose>Close</DialogClose>
    </DialogContent>
  </DialogPortal>
</DialogRoot>`,
    },
    "ui-sdk": {
      imports: {
        "@ui-sdk/vue/dialog": ["Dialog", "DialogBackdrop", "DialogClose", "DialogContent", "DialogDescription", "DialogTitle", "DialogTrigger"],
      },
      template: `<Dialog>
  <DialogTrigger>Open</DialogTrigger>
  <DialogBackdrop />
  <DialogContent>
    <DialogTitle>Project details</DialogTitle>
    <DialogDescription>Review the details before you continue.</DialogDescription>
    <DialogClose>Close</DialogClose>
  </DialogContent>
</Dialog>`,
    },
  },
  {
    name: "Popover",
    reka: {
      imports: { "reka-ui": ["PopoverClose", "PopoverContent", "PopoverPortal", "PopoverRoot", "PopoverTrigger"] },
      template: `<PopoverRoot>
  <PopoverTrigger>Share</PopoverTrigger>
  <PopoverPortal>
    <PopoverContent>
      Anyone with the link can view it.
      <PopoverClose>Done</PopoverClose>
    </PopoverContent>
  </PopoverPortal>
</PopoverRoot>`,
    },
    "ui-sdk": {
      imports: { "@ui-sdk/vue/popover": ["Popover", "PopoverClose", "PopoverContent", "PopoverTrigger"] },
      template: `<Popover>
  <PopoverTrigger>Share</PopoverTrigger>
  <PopoverContent>
    Anyone with the link can view it.
    <PopoverClose>Done</PopoverClose>
  </PopoverContent>
</Popover>`,
    },
  },
  {
    name: "Tooltip",
    reka: {
      imports: { "reka-ui": ["TooltipContent", "TooltipPortal", "TooltipProvider", "TooltipRoot", "TooltipTrigger"] },
      template: `<TooltipProvider>
  <TooltipRoot>
    <TooltipTrigger>Share</TooltipTrigger>
    <TooltipPortal>
      <TooltipContent>Anyone with the link can view</TooltipContent>
    </TooltipPortal>
  </TooltipRoot>
</TooltipProvider>`,
    },
    "ui-sdk": {
      imports: { "@ui-sdk/vue/tooltip": ["Tooltip", "TooltipContent", "TooltipTrigger"] },
      template: `<Tooltip>
  <TooltipTrigger>Share</TooltipTrigger>
  <TooltipContent>Anyone with the link can view</TooltipContent>
</Tooltip>`,
    },
  },
  {
    name: "DropdownMenu / Menu",
    reka: {
      imports: { "reka-ui": ["DropdownMenuContent", "DropdownMenuItem", "DropdownMenuPortal", "DropdownMenuRoot", "DropdownMenuTrigger"] },
      template: `<DropdownMenuRoot>
  <DropdownMenuTrigger>Actions</DropdownMenuTrigger>
  <DropdownMenuPortal>
    <DropdownMenuContent>
      <DropdownMenuItem>Rename</DropdownMenuItem>
      <DropdownMenuItem>Duplicate</DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenuPortal>
</DropdownMenuRoot>`,
    },
    "ui-sdk": {
      imports: { "@ui-sdk/vue/menu": ["Menu", "MenuContent", "MenuItem", "MenuTrigger"] },
      template: `<Menu>
  <MenuTrigger>Actions</MenuTrigger>
  <MenuContent>
    <MenuItem value="rename">Rename</MenuItem>
    <MenuItem value="duplicate">Duplicate</MenuItem>
  </MenuContent>
</Menu>`,
    },
  },
  {
    name: "Select",
    reka: {
      imports: {
        "reka-ui": ["SelectContent", "SelectItem", "SelectItemText", "SelectPortal", "SelectRoot", "SelectTrigger", "SelectValue", "SelectViewport"],
      },
      template: `<SelectRoot>
  <SelectTrigger aria-label="Role">
    <SelectValue placeholder="Select a role" />
  </SelectTrigger>
  <SelectPortal>
    <SelectContent>
      <SelectViewport>
        <SelectItem value="viewer"><SelectItemText>Viewer</SelectItemText></SelectItem>
        <SelectItem value="editor"><SelectItemText>Editor</SelectItemText></SelectItem>
      </SelectViewport>
    </SelectContent>
  </SelectPortal>
</SelectRoot>`,
    },
    "ui-sdk": {
      imports: { "@ui-sdk/vue/select": ["Select", "SelectContent", "SelectItem", "SelectTrigger", "SelectValue"] },
      template: `<Select placeholder="Select a role">
  <SelectTrigger aria-label="Role">
    <SelectValue />
  </SelectTrigger>
  <SelectContent>
    <SelectItem value="viewer">Viewer</SelectItem>
    <SelectItem value="editor">Editor</SelectItem>
  </SelectContent>
</Select>`,
    },
  },
  {
    name: "Combobox",
    reka: {
      imports: {
        "reka-ui": ["ComboboxAnchor", "ComboboxContent", "ComboboxInput", "ComboboxItem", "ComboboxPortal", "ComboboxRoot", "ComboboxViewport"],
      },
      template: `<ComboboxRoot>
  <ComboboxAnchor>
    <ComboboxInput aria-label="Fruit" placeholder="Search fruits" />
  </ComboboxAnchor>
  <ComboboxPortal>
    <ComboboxContent>
      <ComboboxViewport>
        <ComboboxItem value="apple">Apple</ComboboxItem>
        <ComboboxItem value="banana">Banana</ComboboxItem>
      </ComboboxViewport>
    </ComboboxContent>
  </ComboboxPortal>
</ComboboxRoot>`,
    },
    "ui-sdk": {
      imports: { "@ui-sdk/vue/combobox": ["Combobox", "ComboboxContent", "ComboboxInput", "ComboboxItem", "ComboboxList"] },
      template: `<Combobox>
  <ComboboxInput aria-label="Fruit" placeholder="Search fruits" />
  <ComboboxContent>
    <ComboboxList>
      <ComboboxItem value="apple">Apple</ComboboxItem>
      <ComboboxItem value="banana">Banana</ComboboxItem>
    </ComboboxList>
  </ComboboxContent>
</Combobox>`,
    },
  },
]

// The Reka parts that ViteHub uses today, in packages/ui and the Console.
const usedToday = ["Tabs", "Collapsible", "Toast", "Dialog"]

interface Size {
  minified: number
  gzip: number
  lazyGzip: number
}

const dir = join(tmpdir(), `vitehub-headless-weight-${Object.entries(engines).map(([name, version]) => `${name}@${version}`).join("+").replace(/[^\w.@+-]/g, "_")}`)
install()
const src = join(dir, "src")
mkdirSync(src, { recursive: true })

const rows: { name: string; reka: Size; uiSdk: Size; ratio: number }[] = []
for (const component of components) {
  const reka = await measure(`reka-${slug(component.name)}`, [sfc([component.reka])])
  const uiSdk = await measure(`ui-sdk-${slug(component.name)}`, [sfc([component["ui-sdk"]])])
  rows.push({ name: component.name, reka, uiSdk, ratio: uiSdk.gzip / reka.gzip })
}

const four = components.filter(component => usedToday.includes(component.name))
const fourWith = (engine: Engine) => sfc(four.map(component => component[engine]))
const rekaFour = await measure("reka-four", [fourWith("reka")])
const uiSdkFour = await measure("ui-sdk-four", [fourWith("ui-sdk")])
const bothFour = await measure("both-four", [fourWith("reka"), fourWith("ui-sdk")])

const ratios = rows.map(row => row.ratio).toSorted((a, b) => a - b)
const median = ratios[Math.floor(ratios.length / 2)]!
const interimExtra = bothFour.gzip - rekaFour.gzip
const medianFails = median > maxMedianRatio
const interimFails = interimExtra > maxInterimExtraBytes

console.log(`Engines: ${Object.entries(engines).map(([name, version]) => `${name} ${version}`).join(", ")}. Vue is external.`)
console.log("Bytes of the JS that each entry loads up front, minified and gzip level 9. Lazy is gzip of import() chunks.\n")
printTable(
  ["Component", "Reka min", "Reka gzip", "ui-sdk min", "ui-sdk gzip", "ui-sdk lazy", "ui-sdk / Reka"],
  rows.map(row => [row.name, bytes(row.reka.minified), bytes(row.reka.gzip), bytes(row.uiSdk.minified), bytes(row.uiSdk.gzip), bytes(row.uiSdk.lazyGzip), row.ratio.toFixed(2)]),
)
console.log("")
printTable(
  ["Tabs, Collapsible, Toast, Dialog in one entry", "min", "gzip", "lazy"],
  [
    ["Reka alone", bytes(rekaFour.minified), bytes(rekaFour.gzip), bytes(rekaFour.lazyGzip)],
    ["ui-sdk alone", bytes(uiSdkFour.minified), bytes(uiSdkFour.gzip), bytes(uiSdkFour.lazyGzip)],
    ["Both engines", bytes(bothFour.minified), bytes(bothFour.gzip), bytes(bothFour.lazyGzip)],
  ],
)
console.log("")
console.log(`1. Median ratio ui-sdk / Reka: ${median.toFixed(2)} (limit ${maxMedianRatio.toFixed(1)}): ${medianFails ? "fails" : "passes"}`)
console.log(`2. Extra gzip with both engines: ${bytes(interimExtra)} B (limit ${bytes(maxInterimExtraBytes)} B): ${interimFails ? "fails" : "passes"}`)
console.log(`\n${medianFails || interimFails ? "NO-GO" : "GO"}`)
process.exitCode = medianFails || interimFails ? 1 : 0

function install() {
  const marker = join(dir, "installed.json")
  if (existsSync(marker) && readFileSync(marker, "utf8") === JSON.stringify(engines)) {
    return
  }
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "package.json"), `${JSON.stringify({ name: "vitehub-headless-weight", private: true, type: "module" }, null, 2)}\n`)
  // Peers are listed above, so pnpm must not add the optional Nuxt peers of @ui-sdk/vue.
  const specs = Object.entries(engines).map(([name, version]) => `${name}@${version}`)
  const result = spawnSync("pnpm", ["add", "--ignore-workspace", "--save-exact", "--config.auto-install-peers=false", ...specs], { cwd: dir, stdio: "inherit" })
  if (result.status !== 0) {
    throw new Error(`pnpm add failed in ${dir}`)
  }
  writeFileSync(marker, JSON.stringify(engines))
}

function sfc(samples: Sample[]): string {
  const imports = new Map<string, Set<string>>()
  for (const sample of samples) {
    for (const [module, names] of Object.entries(sample.imports)) {
      const set = imports.get(module) ?? new Set()
      for (const name of names) {
        set.add(name)
      }
      imports.set(module, set)
    }
  }
  return [
    "<script setup>",
    ...[...imports].map(([module, names]) => `import { ${[...names].join(", ")} } from ${JSON.stringify(module)}`),
    ...samples.flatMap(sample => sample.script ? [sample.script] : []),
    "</script>",
    "",
    "<template>",
    ...samples.map(sample => `<section>\n${sample.template}\n</section>`),
    "</template>",
    "",
  ].join("\n")
}

// Builds one entry that mounts each component in its own app, and sums the chunks that the entry loads.
async function measure(name: string, sources: string[]): Promise<Size> {
  const mounts = sources.map((source, index) => {
    writeFileSync(join(src, `${name}-${index}.vue`), source)
    return `createApp(App${index}).mount("#app-${index}")`
  })
  const entry = join(src, `${name}.js`)
  writeFileSync(entry, [
    `import { createApp } from "vue"`,
    ...sources.map((_, index) => `import App${index} from "./${name}-${index}.vue"`),
    ...mounts,
    "",
  ].join("\n"))
  const result = await build({
    root: dir,
    configFile: false,
    logLevel: "warn",
    plugins: [vue()],
    build: {
      write: false,
      minify: true,
      modulePreload: false,
      reportCompressedSize: false,
      rolldownOptions: { input: entry, external: ["vue"] },
    },
  })
  const output = (Array.isArray(result) ? result : [result]).flatMap(item => "output" in item ? item.output : [])
  const chunks = new Map(output.flatMap(item => item.type === "chunk" ? [[item.fileName, item] as const] : []))
  const eager = new Set<string>()
  const visit = (chunk: Rolldown.OutputChunk) => {
    if (eager.has(chunk.fileName)) {
      return
    }
    eager.add(chunk.fileName)
    // External imports, like `vue`, have no chunk.
    for (const file of chunk.imports) {
      const imported = chunks.get(file)
      if (imported) {
        visit(imported)
      }
    }
  }
  for (const chunk of chunks.values()) {
    if (chunk.isEntry) {
      visit(chunk)
    }
  }
  const size: Size = { minified: 0, gzip: 0, lazyGzip: 0 }
  for (const chunk of chunks.values()) {
    const code = Buffer.from(chunk.code)
    const gzip = gzipSync(code, { level: 9 }).length
    if (eager.has(chunk.fileName)) {
      size.minified += code.length
      size.gzip += gzip
    }
    else {
      size.lazyGzip += gzip
    }
  }
  return size
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z]+/g, "-")
}

function bytes(value: number): string {
  return value.toLocaleString("en-US")
}

function printTable(header: string[], body: string[][]) {
  const lines = [header, header.map(() => "---"), ...body]
  for (const line of lines) {
    console.log(`| ${line.join(" | ")} |`)
  }
}
