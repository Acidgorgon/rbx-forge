// Where Figma imports and UI Motion exports go in a game project, following its layout: the folder
// of an existing UI Labs storybook (Stories/ with Components/ next to it, as in Forge's template
// src/shared/Interface), else src/shared/Interface. Instance paths come from the active place's Rojo
// project file (the same mapping Forge Sync uses), so requires and warnings match what syncs.
// No electron imports.

import { readdir, readFile, stat } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { instancePathFor } from '../blink.ts'

export interface UiLayout {
  // Repo-relative folders (posix).
  uiDir: string
  components: string
  stories: string
  motion: string
  // The storybook the stories show up in (existing or to be written).
  storybook: string
  storybookExists: boolean
}

const DEFAULT_UI = 'src/shared/Interface'

async function exists(p: string): Promise<boolean> {
  return stat(p).then(
    () => true,
    () => false
  )
}

// Storybooks under src/ (depth-limited walk, skipping packages).
export async function findStorybooks(root: string, maxDepth = 6): Promise<string[]> {
  const out: string[] = []
  const walk = async (rel: string, depth: number) => {
    if (depth > maxDepth || out.length > 20) return
    const names = await readdir(join(root, rel), { withFileTypes: true }).catch(() => [])
    for (const d of names) {
      if (d.name.startsWith('.') || d.name === 'node_modules' || d.name === 'Packages' || d.name === 'DevPackages') continue
      const p = rel ? `${rel}/${d.name}` : d.name
      if (d.isDirectory()) await walk(p, depth + 1)
      else if (/\.storybook\.luau?$/.test(d.name)) out.push(p)
    }
  }
  await walk('src', 0)
  return out.sort((a, b) => (a.startsWith(DEFAULT_UI) ? -1 : 0) - (b.startsWith(DEFAULT_UI) ? -1 : 0) || a.length - b.length || a.localeCompare(b))
}

export async function planLayout(root: string): Promise<UiLayout> {
  const books = await findStorybooks(root)
  if (books.length) {
    const book = books[0]
    const stories = posix.dirname(book)
    const uiDir = posix.basename(stories) === 'Stories' ? posix.dirname(stories) : stories
    return { uiDir, components: `${uiDir}/Components`, stories, motion: `${uiDir}/Motion`, storybook: book, storybookExists: true }
  }
  const uiDir = DEFAULT_UI
  return { uiDir, components: `${uiDir}/Components`, stories: `${uiDir}/Stories`, motion: `${uiDir}/Motion`, storybook: `${uiDir}/Stories/Stories.storybook.luau`, storybookExists: await exists(join(root, uiDir, 'Stories', 'Stories.storybook.luau')) }
}

export async function projectTree(root: string, projectFile: string | null): Promise<Record<string, unknown> | undefined> {
  for (const f of [projectFile, 'default.project.json']) {
    if (!f) continue
    try {
      const j = JSON.parse(await readFile(join(root, f), 'utf8')) as { tree?: Record<string, unknown> }
      if (j.tree) return j.tree
    } catch {
      // try the next
    }
  }
  return undefined
}

// The DataModel path of a repo file ("init.luau" maps to its folder; ".story" stays in the name).
export function instanceOf(tree: Record<string, unknown> | undefined, file: string): string[] | null {
  const p = instancePathFor(tree, file)
  if (!p) return null
  const last = p[p.length - 1]
  if (last === 'init') return p.slice(0, -1)
  return p
}
