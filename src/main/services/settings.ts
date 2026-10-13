import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Per-user settings kept as one JSON file (userData/settings.json in the app).
export class Settings {
  private file: string
  private data: Record<string, unknown> = {}

  constructor(dir: string) {
    this.file = join(dir, 'settings.json')
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8'))
      if (parsed && typeof parsed === 'object') this.data = parsed
    } catch {
      this.data = {}
    }
  }

  get<T>(key: string, fallback: T): T {
    return key in this.data ? (this.data[key] as T) : fallback
  }

  set(key: string, value: unknown): void {
    if (value === undefined) delete this.data[key]
    else this.data[key] = value
    this.save()
  }

  lastProject(): string | undefined {
    const value = this.data.lastProject
    return typeof value === 'string' ? value : undefined
  }

  setLastProject(root: string | undefined): void {
    this.set('lastProject', root)
  }

  private save(): void {
    const dir = join(this.file, '..')
    mkdirSync(dir, { recursive: true })
    const temp = this.file + '.tmp'
    writeFileSync(temp, JSON.stringify(this.data, null, 2))
    renameSync(temp, this.file)
  }
}
