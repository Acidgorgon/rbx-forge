// Explorer rename / delete: the pure rules shared by main (which enforces them) and the renderer
// (which uses them to offer the actions and validate the rename prompt). No node or electron imports.

// Result of an Explorer rename / move to trash (HarnessApi.renamePath / trashPath).
export interface PathChange {
  // Repo-relative entry that changed (the folder, for an init script).
  from: string
  // New repo-relative path (rename), or null (moved to the trash).
  to: string | null
  isDir: boolean
}

// Result of an Explorer multi-select delete (HarnessApi.trashPaths): what went to the trash, and
// what did not with why. Entries inside another listed folder are not tried on their own.
export interface TrashBatchResult {
  changes: PathChange[]
  failed: { path: string; error: string }[]
}

// Rojo script suffixes, longest first: the part a rename keeps.
const SCRIPT_SUFFIX = /(\.server\.luau|\.client\.luau|\.server\.lua|\.client\.lua|\.luau|\.lua)$/
const INIT_FILE = /^init(\.server|\.client)?\.luau?$/
// Windows device names, reserved with or without an extension ("CON", "con.luau", "COM1.txt").
const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i
const BAD_CHARS = /[<>:"/\\|?*\u0000-\u001f]/

function base(path: string): string {
  const i = path.lastIndexOf('/')
  return i < 0 ? path : path.slice(i + 1)
}

function parent(path: string): string {
  const i = path.lastIndexOf('/')
  return i < 0 ? '' : path.slice(0, i)
}

function trimSlashes(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
}

// Problem with a file or folder name on Windows (the strictest of the three platforms), or null.
export function validateFileName(name: string): string | null {
  if (!name || !name.trim()) return 'A name is required.'
  if (name === '.' || name === '..') return `"${name}" is not a valid name.`
  const bad = BAD_CHARS.exec(name)
  if (bad) return bad[0] < ' ' ? 'Names cannot contain control characters.' : `Names cannot contain ${bad[0]}`
  if (/[. ]$/.test(name)) return 'Names cannot end with a dot or a space on Windows.'
  if (/^\s/.test(name)) return 'Names cannot start with a space.'
  if (RESERVED.test(name)) return `"${name.split('.')[0]}" is a reserved name on Windows.`
  if (name.length > 255) return 'That name is too long.'
  return null
}

// The Roblox instance name a directory entry gives (Rojo's rules), e.g. "Foo.server.luau" -> "Foo".
export function instanceNameOf(entry: string, isDir: boolean): string | null {
  if (isDir) return entry
  if (INIT_FILE.test(entry)) return null
  if (/\.meta\.json$/.test(entry)) return null
  const m = /^(.+?)(\.server|\.client)?\.(luau|lua)$/.exec(entry)
  if (m) return m[1]
  const json = /^(.+?)\.(model\.json|json|txt|csv|toml|rbxm|rbxmx)$/.exec(entry)
  return json ? json[1] : null
}

// What a rename or delete acts on for an explorer node: a script file, or the folder of an init
// script ("Foo/init.server.luau" -> "Foo"). `stem` is the editable part, `suffix` what is kept.
export interface EntryTarget {
  path: string
  isDir: boolean
  stem: string
  suffix: string
}

export function entryTarget(path: string, isDir = false): EntryTarget {
  const p = trimSlashes(path)
  if (!isDir && INIT_FILE.test(base(p))) {
    const dir = parent(p)
    return { path: dir, isDir: true, stem: base(dir), suffix: '' }
  }
  if (isDir) return { path: p, isDir: true, stem: base(p), suffix: '' }
  const name = base(p)
  const m = SCRIPT_SUFFIX.exec(name)
  if (m && m.index > 0) return { path: p, isDir: false, stem: name.slice(0, m.index), suffix: m[1] }
  return { path: p, isDir: false, stem: name, suffix: '' }
}

// New repo-relative path when the entry's editable part becomes `stem`.
export function renamedPath(target: EntryTarget, stem: string): string {
  const dir = parent(target.path)
  return (dir ? `${dir}/` : '') + stem + target.suffix
}

// Problem with renaming `target` to `stem`, given the names of the entries next to it, or null.
// Rojo names instances by stem, so "Foo.luau" next to "Bar.server.luau" or a "Bar" folder collides
// with "Bar"; the comparison ignores case (Windows and macOS file systems do).
export function renameProblem(target: EntryTarget, stem: string, siblings: { name: string; isDir: boolean }[]): string | null {
  const own = base(target.path)
  if (stem === target.stem) return 'Pick a new name.'
  const invalid = validateFileName(stem) ?? validateFileName(stem + target.suffix)
  if (invalid) return invalid
  if (target.suffix) {
    // "X.server" + ".luau" would turn a ModuleScript into a Script; "init" into its folder's script.
    if (INIT_FILE.test(stem + target.suffix)) return '"init" names the folder\'s own script; pick another name.'
    const back = entryTarget(stem + target.suffix)
    if (back.stem !== stem || back.suffix !== target.suffix) return `"${stem}" would change the script type; leave out .server / .client / .luau.`
  }
  const next = (stem + target.suffix).toLowerCase()
  const want = stem.toLowerCase()
  for (const s of siblings) {
    if (s.name === own) continue
    if (s.name.toLowerCase() === next) return `"${stem + target.suffix}" already exists here.`
    const inst = instanceNameOf(s.name, s.isDir)
    if (inst !== null && inst.toLowerCase() === want && (target.isDir || target.suffix)) return `"${stem}" already exists here.`
  }
  return null
}

// Why a path must not be renamed or deleted from the Explorer, or null. Protected: the project root,
// project files, anything under .git, and every folder or file a *.project.json maps with $path
// (renaming one would break the project file) plus the folders that contain one.
export function protectedReason(path: string, mounts: string[]): string | null {
  const p = trimSlashes(path)
  if (!p || p === '.' || p.split('/').includes('..')) return 'That is the project folder.'
  if (/(^|\/)\.git(\/|$)/.test(p)) return 'Git internals are not editable here.'
  if (!p.includes('/') && /\.project\.json$/.test(p)) return 'Project files are not renamed or deleted from the Explorer.'
  for (const raw of mounts) {
    const m = trimSlashes(raw)
    if (!m) continue
    if (m === p) return `${p} is mapped in the project file; change it there.`
    if (m.startsWith(p + '/')) return `${p} holds ${m}, which the project file maps.`
  }
  return null
}

// Open buffers a rename moves: every path equal to `from` or under it (a folder), mapped to `to`.
export function movedPath(path: string, from: string, to: string): string | null {
  if (path === from) return to
  if (path.startsWith(from + '/')) return to + path.slice(from.length)
  return null
}

export function isUnder(path: string, entry: string): boolean {
  return path === entry || path.startsWith(entry + '/')
}

// Entries directly in `dir`, as far as a list of known repo-relative file paths tells.
export function siblingsOf(dir: string, paths: string[]): { name: string; isDir: boolean }[] {
  const out = new Map<string, boolean>()
  for (const p of paths) {
    if (dir && !p.startsWith(dir + '/')) continue
    const [head, ...more] = (dir ? p.slice(dir.length + 1) : p).split('/')
    if (head) out.set(head, (out.get(head) ?? false) || more.length > 0)
  }
  return [...out].map(([name, isDir]) => ({ name, isDir }))
}

export function parentDir(path: string): string {
  return parent(trimSlashes(path))
}
