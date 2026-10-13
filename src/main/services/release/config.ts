import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { parseSemver } from './version.ts'
import type { PublishConfig } from './types.ts'

// Release settings shared by the team, in .forge/project.json next to the collab settings:
//   "version": "1.4.2",                       optional; when present it is bumped in a release commit
//   "publish": { "mode": "studio", "placeId": 123, "universeId": 456, "versionType": "Published" }
// No secrets ever go here. collab/config.ts ProjectConfigSchema strips unknown keys when it writes the
// file, so the integrator must merge ReleaseProjectFields into it (see CONTRACT.md). Until then this
// module reads and writes the raw JSON so nothing else in the file is lost.

export const PROJECT_JSON = '.forge/project.json'

const positiveInt = z.coerce.number().int().positive()

export const PublishConfigSchema = z.object({
  mode: z.enum(['rojo', 'studio', 'file']).optional(),
  placeId: positiveInt.optional(),
  universeId: positiveInt.optional(),
  placeFile: z.string().max(1024).optional(),
  versionType: z.enum(['Saved', 'Published']).optional(),
  rojoProject: z.string().max(260).regex(/\.project\.json$/, 'Must be a *.project.json file').optional(),
  tagPrefix: z.string().max(20).regex(/^[A-Za-z0-9._/-]*$/).optional()
})

// Merge into collab ProjectConfigSchema: ProjectConfigSchema.extend(ReleaseProjectFields).
export const ReleaseProjectFields = {
  version: z
    .string()
    .refine((v) => parseSemver(v) !== null, 'Use a semantic version like 1.2.3')
    .optional(),
  publish: PublishConfigSchema.optional()
}

export interface ReleaseProjectConfig {
  version: string | null
  publish: PublishConfig
  issues: string[]
}

async function readRaw(root: string): Promise<Record<string, unknown> | null> {
  try {
    const json = JSON.parse(await readFile(join(root, PROJECT_JSON), 'utf8'))
    return json && typeof json === 'object' && !Array.isArray(json) ? json : null
  } catch {
    return null
  }
}

export async function readReleaseConfig(root: string): Promise<ReleaseProjectConfig> {
  const raw = (await readRaw(root)) ?? {}
  const issues: string[] = []
  let publish: PublishConfig = {}
  if (raw.publish !== undefined) {
    const parsed = PublishConfigSchema.safeParse(raw.publish)
    if (parsed.success) publish = parsed.data
    else issues.push(...parsed.error.issues.map((i) => `publish.${i.path.join('.')}: ${i.message}`))
  }
  let version: string | null = null
  if (typeof raw.version === 'string') {
    if (parseSemver(raw.version)) version = raw.version.trim().replace(/^v/, '')
    else issues.push(`version: "${raw.version}" is not a semantic version`)
  }
  return { version, publish, issues }
}

// Updates only the "version" key, keeping every other key and the 2-space format collab uses.
export async function writeProjectVersion(root: string, version: string): Promise<void> {
  const raw = (await readRaw(root)) ?? {}
  raw.version = version
  await mkdir(join(root, '.forge'), { recursive: true })
  await writeFile(join(root, PROJECT_JSON), JSON.stringify(raw, null, 2) + '\n', 'utf8')
}

// Place IDs from tools/studio-sync.json (GenTree's Studio sync config), used when publish.placeId is unset.
export async function studioSyncPlaceIds(root: string): Promise<number[]> {
  try {
    const json = JSON.parse(await readFile(join(root, 'tools', 'studio-sync.json'), 'utf8')) as { placeIds?: unknown }
    if (!Array.isArray(json.placeIds)) return []
    return json.placeIds.map((v) => Number(v)).filter((n) => Number.isSafeInteger(n) && n > 0)
  } catch {
    return []
  }
}
