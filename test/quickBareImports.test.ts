// Quick updates run the main-process code from userData/code/<version>/main/app.js, outside the
// installed app. Packages resolve there only through NODE_PATH (src/main/bootstrap.ts), which
// require() honours but a dynamic import() does not, so main-process code must not import() a
// package by name. (Node built-ins and electron are always resolvable.)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? files(path) : /\.tsx?$/.test(name) ? [path] : []
  })
}

test('main-process code never import()s a package by name', () => {
  const bad: string[] = []
  for (const file of files('src/main')) {
    const text = readFileSync(file, 'utf8')
    for (const m of text.matchAll(/(?<![\w.])import\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      const spec = m[1]
      if (spec.startsWith('.') || spec.startsWith('node:') || spec === 'electron' || spec.startsWith('@shared/')) continue
      // `import('x').Type` in a type position is erased at build time.
      if (text.slice(m.index! + m[0].length).startsWith('.')) continue
      bad.push(`${file}: import('${spec}')`)
    }
  }
  assert.deepEqual(bad, [])
})
