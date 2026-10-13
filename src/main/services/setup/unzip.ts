import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import { inflateRawSync } from 'node:zlib'

// Minimal zip reader for GitHub's codeload archives (the template download when git is missing).
// Reads the central directory, so archives with data descriptors work; supports stored (0) and
// deflate (8) entries, keeps the Unix executable bit, and refuses entries that leave dest.

export interface ZipEntry {
  name: string
  data: Buffer
  executable: boolean
  directory: boolean
}

export function readZip(buffer: Buffer): ZipEntry[] {
  // End of central directory: signature 0x06054b50, searched from the end (comment up to 64 KB).
  let eocd = -1
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 22 - 0xffff); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('Not a zip archive')
  const count = buffer.readUInt16LE(eocd + 10)
  let offset = buffer.readUInt32LE(eocd + 16)
  const entries: ZipEntry[] = []
  for (let n = 0; n < count; n++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('Corrupt zip central directory')
    const method = buffer.readUInt16LE(offset + 10)
    const compressed = buffer.readUInt32LE(offset + 20)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    const external = buffer.readUInt32LE(offset + 38)
    const local = buffer.readUInt32LE(offset + 42)
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8')
    offset += 46 + nameLength + extraLength + commentLength
    const directory = name.endsWith('/')
    const mode = external >>> 16
    let data = Buffer.alloc(0)
    if (!directory) {
      if (buffer.readUInt32LE(local) !== 0x04034b50) throw new Error(`Corrupt zip entry ${name}`)
      const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28)
      const raw = buffer.subarray(start, start + compressed)
      if (method === 0) data = Buffer.from(raw)
      else if (method === 8) data = inflateRawSync(raw)
      else throw new Error(`Unsupported zip compression ${method} for ${name}`)
    }
    entries.push({ name, data, executable: (mode & 0o111) !== 0, directory })
  }
  return entries
}

// Extracts into dest. stripTop drops the archive's single top folder ("Repo-master/").
export function extractZip(buffer: Buffer, dest: string, stripTop = true): number {
  const entries = readZip(buffer)
  const tops = new Set(entries.map((e) => e.name.split('/')[0]))
  const strip = stripTop && tops.size === 1 && entries.every((e) => e.name.includes('/') || e.directory)
  const base = resolve(dest)
  let files = 0
  for (const entry of entries) {
    let name = entry.name.replace(/\\/g, '/')
    if (strip) name = name.split('/').slice(1).join('/')
    if (!name || name.split('/').includes('..')) continue
    const target = resolve(base, name)
    if (target !== base && !target.startsWith(base + sep)) continue
    if (entry.directory) {
      mkdirSync(target, { recursive: true })
      continue
    }
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, entry.data)
    if (entry.executable && process.platform !== 'win32') chmodSync(target, 0o755)
    files++
  }
  return files
}

// Tiny zip writer (stored entries) for tests and fixtures.
export function writeZip(files: { name: string; data: Buffer | string; executable?: boolean }[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const file of files) {
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data)
    const name = Buffer.from(file.name)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(0x0314, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    const mode = file.name.endsWith('/') ? 0o40755 : file.executable ? 0o100755 : 0o100644
    central.writeUInt32LE((mode << 16) >>> 0, 38)
    central.writeUInt32LE(offset, 42)
    locals.push(local, name, data)
    centrals.push(central, name)
    offset += 30 + name.length + data.length
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, ...centrals, end])
}

