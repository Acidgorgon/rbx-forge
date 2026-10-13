import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { ReleaseProjectFields } from '../release/config.ts'

// .forge/project.json: settings the whole team shares by committing them with the game, as opposed
// to per-user settings in the app's userData folder.

export const FORGE_DIR = '.forge'
export const PROJECT_CONFIG_PATH = '.forge/project.json'
export const FORGE_README_PATH = '.forge/README.md'

export const TestScenarioSchema = z.object({
  name: z.string().trim().min(1, 'Scenario name is required').max(200),
  steps: z.array(z.string().trim().min(1)).max(100)
})

export const ProjectConfigSchema = z.object({
  // Free text: naming, folder layout, review habits. Shown to people and given to the AI.
  conventions: z.string().max(20_000).default(''),
  // Extra rules added to the chat/test agents' instructions for this game.
  aiRules: z.string().max(20_000).default(''),
  testScenarios: z.array(TestScenarioSchema).max(200).default([]),
  lint: z
    .object({
      selene: z.boolean().default(true),
      stylua: z.boolean().default(false)
    })
    .default({ selene: true, stylua: false }),
  // Prefix for feature branches, e.g. "feature/" or "alex/".
  branchPrefix: z
    .string()
    .max(60)
    .regex(/^[A-Za-z0-9._/-]*$/, 'Use letters, digits, ".", "_", "-" or "/"')
    .optional(),
  // Release settings (release/config.ts): "version" and "publish". Kept in this schema so saving the
  // collab settings never drops them.
  ...ReleaseProjectFields
})
  // Keys written by other tools or newer Forge versions survive a save.
  .loose()

export type TestScenario = z.infer<typeof TestScenarioSchema>
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>

export const DEFAULT_BRANCH_PREFIX = 'feature/'

export function defaultProjectConfig(): ProjectConfig {
  return ProjectConfigSchema.parse({})
}

export interface ConfigIssue {
  path: string
  message: string
}

export type ValidateResult = { ok: true; config: ProjectConfig } | { ok: false; issues: ConfigIssue[] }

// .forge/ is committed: refuse anything that looks like a secret (Discord webhook URLs, Open Cloud
// keys, provider API keys). Secrets live only in the app's safeStorage-encrypted store.
const SECRET_PATTERNS: [RegExp, string][] = [
  [/https?:\/\/(?:[a-z]+\.)?discord(?:app)?\.com\/api\/webhooks\//i, 'a Discord webhook URL'],
  [/\bsk-(?:ant-|proj-|or-)?[A-Za-z0-9_-]{20,}/, 'an API key'],
  [/\bAIza[0-9A-Za-z_-]{30,}/, 'a Google API key'],
  [/[{,]"(?:openCloudApiKey|apiKey|api_key|webhook|webhookUrl|token|secret|password)":/i, 'a secret field']
]

export function findSecretInConfig(value: unknown): string | null {
  const text = JSON.stringify(value ?? null)
  for (const [re, what] of SECRET_PATTERNS) if (re.test(text)) return what
  return null
}

export function validateProjectConfig(value: unknown): ValidateResult {
  const secret = findSecretInConfig(value)
  if (secret) {
    return { ok: false, issues: [{ path: '(root)', message: `Looks like ${secret}. .forge/project.json is committed; store secrets in Forge's encrypted settings instead.` }] }
  }
  const parsed = ProjectConfigSchema.safeParse(value)
  if (parsed.success) return { ok: true, config: parsed.data }
  return {
    ok: false,
    issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.') || '(root)', message: issue.message }))
  }
}

export interface ReadConfigResult {
  exists: boolean
  // Always usable: the file's values, or defaults when it is missing or invalid.
  config: ProjectConfig
  issues?: ConfigIssue[]
}

export async function readProjectConfig(root: string): Promise<ReadConfigResult> {
  let text: string
  try {
    text = await readFile(join(root, PROJECT_CONFIG_PATH), 'utf8')
  } catch {
    return { exists: false, config: defaultProjectConfig() }
  }
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch (error) {
    return {
      exists: true,
      config: defaultProjectConfig(),
      issues: [{ path: '(file)', message: `Not valid JSON: ${error instanceof Error ? error.message : String(error)}` }]
    }
  }
  const result = validateProjectConfig(json)
  if (result.ok) return { exists: true, config: result.config }
  return { exists: true, config: defaultProjectConfig(), issues: result.issues }
}

// Validates, then writes .forge/project.json (and .forge/README.md when missing). Throws on invalid input.
export async function writeProjectConfig(root: string, value: unknown): Promise<ProjectConfig> {
  const result = validateProjectConfig(value)
  if (!result.ok) throw new Error(result.issues.map((i) => `${i.path}: ${i.message}`).join('; '))
  await mkdir(join(root, FORGE_DIR), { recursive: true })
  await writeFile(join(root, PROJECT_CONFIG_PATH), JSON.stringify(result.config, null, 2) + '\n', 'utf8')
  await ensureForgeReadme(root)
  return result.config
}

export async function ensureForgeReadme(root: string): Promise<boolean> {
  const file = join(root, FORGE_README_PATH)
  try {
    await readFile(file)
    return false
  } catch {
    await mkdir(join(root, FORGE_DIR), { recursive: true })
    await writeFile(file, FORGE_README, 'utf8')
    return true
  }
}

export const FORGE_README = `# .forge

This folder holds team settings for **RBX Forge**, the desktop app some of us use to work on this
game. It is committed with the game so everyone gets the same setup. You do not need Forge to work
on the game; these are plain files you can edit by hand.

## project.json

\`\`\`json
{
  "conventions": "How we name and organise things. Read by people and given to the AI.",
  "aiRules": "Extra rules for Forge's AI chat and test agents in this game.",
  "testScenarios": [{ "name": "Buy a sword", "steps": ["Join", "Open shop", "Buy Starter Sword"] }],
  "lint": { "selene": true, "stylua": false },
  "branchPrefix": "feature/",
  "version": "1.4.2",
  "publish": { "mode": "studio", "placeId": 1234567, "universeId": 7654321, "versionType": "Published" }
}
\`\`\`

- **conventions**: house style in plain words (naming, where new code goes, review habits).
- **aiRules**: added to the AI's instructions, e.g. "never change prices in Configs without asking".
- **testScenarios**: saved play-test scenarios anyone can run from the Test panel.
- **lint**: which checks run before Forge syncs your work. Selene ships with the template;
  StyLua needs \`stylua\` in rokit.toml and a stylua.toml before turning it on.
- **branchPrefix**: prefix for branches made with *Start feature branch* (default \`feature/\`).
- **version** (optional): the game's release version. When present, each release made with Forge
  commits the bump here; otherwise the version lives only in git tags (\`v1.4.2\`).
- **publish** (optional): how releases are published: \`mode\` (\`studio\`, \`file\` or \`rojo\`),
  \`placeId\`, \`universeId\`, \`versionType\` (\`Saved\` / \`Published\`), \`placeFile\`,
  \`rojoProject\`, \`tagPrefix\`. **Never put API keys or webhook URLs here**: Forge stores those
  encrypted on each person's computer.

## claims.json

"Working on" markers, so two people do not build the same thing at once. Each entry says who
(git user.name), what (a file, folder or feature), since when, and an optional note. Forge adds and
removes entries for you and commits only this file; it travels with the normal sync. Claims older
than three days are shown as stale, and the same thing claimed by two people is flagged.
\`.gitattributes\` marks this file \`merge=union\`, so two people claiming at once never conflict.

Claims are a courtesy, not a lock: git will still merge anyone's changes.
`
