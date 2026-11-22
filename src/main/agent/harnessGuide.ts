// Generates and safely maintains cross-harness workspace instructions for RBX Forge
// (AGENTS.md for Codex / Antigravity / RBX Forge / Cursor, CLAUDE.md for Claude Code,
// and .agents/rules/rbx-forge.md for Antigravity). Pure Node; zero Electron imports.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export const GUIDE_START = '<!-- rbx-forge:guide:start -->'
export const GUIDE_END = '<!-- rbx-forge:guide:end -->'
export const HARNESS_GUIDE_CONFIG = '.forge/harness-guide.json'

export type HarnessTargetId = 'agents' | 'claude' | 'antigravity'

export const HARNESS_TARGETS: Record<HarnessTargetId, { file: string; label: string; harnesses: string }> = {
  agents: { file: 'AGENTS.md', label: 'AGENTS.md', harnesses: 'Codex, Antigravity, RBX Forge, Cursor' },
  claude: { file: 'CLAUDE.md', label: 'CLAUDE.md', harnesses: 'Claude Code' },
  antigravity: { file: '.agents/rules/rbx-forge.md', label: '.agents/rules/rbx-forge.md', harnesses: 'Antigravity workspace rules' }
}

export const HARNESS_TARGET_IDS: readonly HarnessTargetId[] = ['agents', 'claude', 'antigravity']

export interface HarnessGuideOptions {
  targets: HarnessTargetId[]
  noComments: boolean
  enforceHarborAndPackages: boolean
  enforceDirectSyncAndGit: boolean
  enforceOfflineVanguards: boolean
  enforceProjectStructure: boolean
  customRules?: string
}

export const DEFAULT_HARNESS_GUIDE_OPTIONS: HarnessGuideOptions = {
  targets: ['agents', 'claude', 'antigravity'],
  noComments: true,
  enforceHarborAndPackages: true,
  enforceDirectSyncAndGit: true,
  enforceOfflineVanguards: true,
  enforceProjectStructure: true,
  customRules: ''
}

export interface HarnessGuideFileState {
  id: HarnessTargetId
  file: string
  label: string
  harnesses: string
  exists: boolean
  hasManagedBlock: boolean
  upToDate: boolean
}

export interface HarnessGuideStatus {
  projectRoot: string | null
  options: HarnessGuideOptions
  files: HarnessGuideFileState[]
  preview: string
}

export interface HarnessGuideSyncResult {
  written: string[]
  status: HarnessGuideStatus
}

function mergeOptions(base: HarnessGuideOptions, patch?: Partial<HarnessGuideOptions>): HarnessGuideOptions {
  if (!patch) return { ...base, targets: [...base.targets] }
  const targets = Array.isArray(patch.targets)
    ? patch.targets.filter((t): t is HarnessTargetId => t === 'agents' || t === 'claude' || t === 'antigravity')
    : base.targets
  return {
    targets: targets.length ? [...new Set(targets)] : [...base.targets],
    noComments: typeof patch.noComments === 'boolean' ? patch.noComments : base.noComments,
    enforceHarborAndPackages:
      typeof patch.enforceHarborAndPackages === 'boolean' ? patch.enforceHarborAndPackages : base.enforceHarborAndPackages,
    enforceDirectSyncAndGit:
      typeof patch.enforceDirectSyncAndGit === 'boolean' ? patch.enforceDirectSyncAndGit : base.enforceDirectSyncAndGit,
    enforceOfflineVanguards:
      typeof patch.enforceOfflineVanguards === 'boolean' ? patch.enforceOfflineVanguards : base.enforceOfflineVanguards,
    enforceProjectStructure:
      typeof patch.enforceProjectStructure === 'boolean' ? patch.enforceProjectStructure : base.enforceProjectStructure,
    customRules: typeof patch.customRules === 'string' ? patch.customRules : base.customRules
  }
}

export function buildHarnessGuideMarkdown(rawOpts: Partial<HarnessGuideOptions>, target: HarnessTargetId): string {
  const opts = mergeOptions(DEFAULT_HARNESS_GUIDE_OPTIONS, rawOpts)

  if (target === 'claude') {
    const bullets: string[] = [
      'Read and follow `AGENTS.md` first before planning, editing, syncing, or importing.'
    ]
    if (opts.enforceDirectSyncAndGit) {
      bullets.push(
        '**RBX Forge Sync & Assets**: Do not launch separate `rojo serve` processes or overwrite Studio-only instances. Let RBX Forge Direct Sync + `sourcemap.json` handle disk/Studio sync, import `.rbxm`/media via RBX Forge Inbox / `fm/insert_rbxm.py` (never `125988560196910`), and commit clean diffs through Git / RBX Forge Source Control.'
      )
    }
    if (opts.enforceHarborAndPackages) {
      bullets.push(
        '**Packages & Harbor Stack**: Never hand-edit `Packages/`, `ServerPackages/`, or `DevPackages/`. Use installed Wally packages and the Harbor Stack (`Current`, `Ripple`, `Anchor`, `Tide`, `Lighthouse`) with lossless `LibsConfig.luau` toggles and schema codegen (`current-schema.luau`, `*.blink`, `*.ripple`).'
      )
    }
    if (opts.enforceProjectStructure) {
      bullets.push(
        '**Project Structure**: Keep shared contracts in `src/shared`, server authority in `src/server`, client UI/controllers in `src/client`, and follow existing `--!strict` and module return conventions.'
      )
    }
    if (opts.enforceOfflineVanguards) {
      bullets.push(
        '**Offline Verification**: Use `rur` for UI stories and `ror` (`ROR_BACKEND=dx12`, `ROR_MEMORY_FLOOR_GB=2`) / `fm` scripts for 3D models & environments before touching live Studio.'
      )
    }
    if (opts.noComments) {
      bullets.push(
        '**No Comments**: Do not add code comments in Luau or TypeScript files unless explicitly requested; use clear symbol names instead.'
      )
    }
    if (opts.customRules?.trim()) {
      bullets.push('', '## Custom Rules', '', opts.customRules.trim())
    }
    return [GUIDE_START, '# RBX Forge Workspace Rules', '', ...bullets.map((b) => (b.startsWith('#') || !b ? b : `- ${b}`)), GUIDE_END].join('\n')
  }

  const sections: string[] = [
    '# RBX Forge Workspace Instructions',
    '',
    'These workspace rules are managed by RBX Forge so any harness (Claude Code, Antigravity, Codex, or RBX Forge) follows one workflow.'
  ]

  if (opts.enforceDirectSyncAndGit) {
    sections.push(
      '',
      '## Sync, Importing & Version Control',
      '- **Syncing (RBX Forge Direct Sync)**: RBX Forge handles 2-way disk/Studio sync and generates `sourcemap.json` automatically. Do not start separate `rojo serve` daemons or bypass 3-way conflict resolution.',
      '- **Importing Assets & `.rbxm`**: Import models, meshes, decals, and audio through RBX Forge Model/Media Inbox (Open Cloud) or `fm/insert_rbxm.py`. Never use `insert_rbxm` against Forge-Sync linked place `125988560196910`.',
      '- **Version Control**: Stage and commit clean changes via Git / RBX Forge Source Control. Never force-push, discard teammate Studio edits, or commit `.forge/cache`, `out/`, or temp render artifacts.',
      '- **Studio Coordination**: Prefer offline verification first; never run concurrent Studio-mutating operations from multiple agents at once.'
    )
  }

  if (opts.enforceHarborAndPackages) {
    sections.push(
      '',
      '## Packages & Harbor Family Stack',
      '- **Packages**: Never hand-edit files inside `Packages/`, `ServerPackages/`, or `DevPackages/`. Install or update dependencies through Wally/Rokit or RBX Forge Packages.',
      '- **Harbor Stack**: Use the Harbor libraries installed in this repo (`Current`, `Ripple`, `Anchor`, `Tide`, `Lighthouse`) instead of re-implementing networking, state replication, persistence, scheduling, or telemetry.',
      '- **Schemas & Config**: Toggle Harbor libraries cleanly in `LibsConfig.luau` without rewriting unrelated formatting, and regenerate networking/state code from schemas (`tools/current-schema.luau`, `*.blink`, `*.ripple`) rather than editing generated outputs.'
    )
  }

  if (opts.enforceProjectStructure) {
    sections.push(
      '',
      '## Project Structure & Code Boundaries',
      '- Keep server-authoritative gameplay logic under `src/server`, client controllers/UI under `src/client`, and shared types/configs/components under `src/shared`.',
      '- Group multi-part systems under feature modules (shared + Service + Controller) and keep UI component previews in `*.story.luau`.',
      '- Match existing `--!strict`, require style (`ReplicatedStorage.Shared` / `Packages`), and module return style.'
    )
  }

  if (opts.enforceOfflineVanguards) {
    sections.push(
      '',
      '## Offline UI & 3D Previews (Vanguards)',
      '- Verify UI stories offline with `rur` (`rur render --story ...` or UI Preview `rur` mode) before opening Studio.',
      '- Render and inspect 3D models/environments offline with `ror` (`ROR_BACKEND=dx12`, `ROR_MEMORY_FLOOR_GB=2`), `fm/modelpreview.py`, and `fm/envbuild.py` (using headless `ree` where needed).',
      '- Keep GPL toolchains (`ror`, `rur`, `ree`) strictly as external CLI tools — never copy their source code or shaders into game repositories.'
    )
  }

  if (opts.noComments) {
    sections.push(
      '',
      '## Style & Comments',
      '- **No Comments**: Do not write inline, block, or file-header comments in edited or newly created Luau/TypeScript files unless the user explicitly asks for comments. Write self-explanatory identifiers and small, single-purpose functions.'
    )
  }

  if (opts.customRules?.trim()) {
    sections.push('', '## Custom Rules', '', opts.customRules.trim())
  }

  return [GUIDE_START, ...sections, GUIDE_END].join('\n')
}

export function upsertManagedBlock(existing: string | null, managedBlock: string): string {
  const managedNorm = managedBlock.replace(/\r\n/g, '\n').trim()
  const useCrlf = existing?.includes('\r\n') ?? false

  let out: string
  if (existing != null) {
    const norm = existing.replace(/\r\n/g, '\n')
    const startIdx = norm.indexOf(GUIDE_START)
    const endIdx = norm.indexOf(GUIDE_END)
    if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
      out = norm.slice(0, startIdx) + managedNorm + norm.slice(endIdx + GUIDE_END.length)
      if (!out.endsWith('\n')) out += '\n'
    } else if (norm.trim().length > 0) {
      out = norm.replace(/\n+$/, '') + '\n\n' + managedNorm + '\n'
    } else {
      out = managedNorm + '\n'
    }
  } else {
    out = managedNorm + '\n'
  }

  return useCrlf ? out.replace(/\n/g, '\r\n') : out
}

function readSavedOptions(projectRoot: string): Partial<HarnessGuideOptions> | undefined {
  const cfgPath = join(projectRoot, HARNESS_GUIDE_CONFIG)
  if (!existsSync(cfgPath)) return undefined
  try {
    const raw = JSON.parse(readFileSync(cfgPath, 'utf8'))
    return raw && typeof raw === 'object' ? (raw as Partial<HarnessGuideOptions>) : undefined
  } catch {
    return undefined
  }
}

export function inspectHarnessGuide(projectRoot: string | null, patch?: Partial<HarnessGuideOptions>): HarnessGuideStatus {
  const saved = projectRoot ? readSavedOptions(projectRoot) : undefined
  const options = mergeOptions(mergeOptions(DEFAULT_HARNESS_GUIDE_OPTIONS, saved), patch)
  const files: HarnessGuideFileState[] = HARNESS_TARGET_IDS.map((id) => {
    const meta = HARNESS_TARGETS[id]
    if (!projectRoot) {
      return { id, ...meta, exists: false, hasManagedBlock: false, upToDate: false }
    }
    const abs = join(projectRoot, ...meta.file.split('/'))
    if (!existsSync(abs)) {
      return { id, ...meta, exists: false, hasManagedBlock: false, upToDate: false }
    }
    try {
      const content = readFileSync(abs, 'utf8').replace(/\r\n/g, '\n')
      const hasManagedBlock = content.includes(GUIDE_START) && content.includes(GUIDE_END)
      const expected = buildHarnessGuideMarkdown(options, id).replace(/\r\n/g, '\n')
      const upToDate = hasManagedBlock && content.includes(expected)
      return { id, ...meta, exists: true, hasManagedBlock, upToDate }
    } catch {
      return { id, ...meta, exists: false, hasManagedBlock: false, upToDate: false }
    }
  })

  return {
    projectRoot,
    options,
    files,
    preview: buildHarnessGuideMarkdown(options, 'agents')
  }
}

export function syncHarnessGuide(projectRoot: string, patch?: Partial<HarnessGuideOptions>): HarnessGuideSyncResult {
  const root = resolve(projectRoot)
  const saved = readSavedOptions(root)
  const options = mergeOptions(mergeOptions(DEFAULT_HARNESS_GUIDE_OPTIONS, saved), patch)

  const cfgPath = join(root, HARNESS_GUIDE_CONFIG)
  mkdirSync(dirname(cfgPath), { recursive: true })
  writeFileSync(cfgPath, JSON.stringify(options, null, 2) + '\n', 'utf8')

  const written: string[] = []
  for (const id of options.targets) {
    const meta = HARNESS_TARGETS[id]
    const abs = join(root, ...meta.file.split('/'))
    mkdirSync(dirname(abs), { recursive: true })
    const existing = existsSync(abs) ? readFileSync(abs, 'utf8') : null
    const managed = buildHarnessGuideMarkdown(options, id)
    let next = upsertManagedBlock(existing, managed)
    if (id === 'antigravity' && !next.trimStart().startsWith('---')) {
      const eol = next.includes('\r\n') ? '\r\n' : '\n'
      next = `---${eol}trigger: always_on${eol}---${eol}${eol}${next}`
    }
    if (existing !== next) {
      writeFileSync(abs, next, 'utf8')
      written.push(meta.file)
    }
  }

  return {
    written,
    status: inspectHarnessGuide(root, options)
  }
}
