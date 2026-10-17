// Settings navigation: categories (left rail) and sections (the `set-<id>` cards), plus a way for the rest of the app
// to open Settings at a section. Only one category is shown at a time; the others stay mounted but hidden.

export type SettingsCategory = 'general' | 'ai' | 'spending' | 'editing' | 'studio' | 'labs'

export const SETTINGS_CATEGORIES: { id: SettingsCategory; label: string; sections: [id: string, label: string, keywords?: string][] }[] = [
  { id: 'general', label: 'General', sections: [['appearance', 'Appearance', 'theme dark light motion font'], ['notifications', 'Notifications', 'sound digest restore away'], ['updates', 'Updates', 'version channel quick update']] },
  { id: 'ai', label: 'AI & models', sections: [['accounts', 'Accounts', 'sign in api key claude openai codex chatgpt gemini openrouter'], ['model', 'Default model', 'auto-route effort reasoning'], ['chat', 'Chat', 'restate'], ['providers', 'Providers', 'ollama custom base url local']] },
  { id: 'spending', label: 'Spending', sections: [['usage', 'Usage', 'spending cap daily monthly cost'], ['budgets', 'Budgets', 'tokens warning']] },
  { id: 'editing', label: 'Editing', sections: [['editor', 'Editor', 'format stylua autosave completions delete confirm']] },
  { id: 'studio', label: 'Studio & sync', sections: [['places', 'Places', 'serve rojo'], ['sync', 'Sync', 'studio engine team auto commit'], ['studio-mcp', 'Studio tools', 'roblox studio mcp assistant playtest luau execute console screen capture connection'], ['toolchain', 'Toolchain', 'rokit rojo wally lune luau-lsp install']] },
  { id: 'labs', label: 'Labs & integrations', sections: [['labs', 'Labs', 'vfx animation ability tiers cheap default critic model dropdown decision gates models tokens'], ['integrations', 'Integrations', 'figma token']] }
]

export function categoryOf(section: string): SettingsCategory | undefined {
  return SETTINGS_CATEGORIES.find((c) => c.sections.some(([id]) => id === section))?.id
}

const STORE_KEY = 'forge.settings.category'
export function loadCategory(): SettingsCategory {
  try {
    const v = localStorage.getItem(STORE_KEY)
    if (v && SETTINGS_CATEGORIES.some((c) => c.id === v)) return v as SettingsCategory
  } catch {
    /* storage unavailable */
  }
  return 'general'
}
export function saveCategory(c: SettingsCategory): void {
  try {
    localStorage.setItem(STORE_KEY, c)
  } catch {
    /* storage unavailable */
  }
}

// Open Settings at a section: call after actions.openPage('settings'). Works whether or not the page is mounted yet.
export const SETTINGS_SECTION_EVENT = 'forge:settings-section'
let pending: string | null = null
export function showSettingsSection(section: string): void {
  pending = section
  window.dispatchEvent(new CustomEvent(SETTINGS_SECTION_EVENT, { detail: section }))
}
export function takePendingSection(): string | null {
  const p = pending
  pending = null
  return p
}
