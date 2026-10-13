import type { RobloxPaths } from './types'

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/

function quote(name: string): string {
  return JSON.stringify(name)
}

// instancePath starts at a service, e.g. ["ReplicatedStorage", "Assets", "Sword Model"].
export function robloxPaths(instancePath: string[]): RobloxPaths {
  const [service, ...rest] = instancePath
  if (!service) {
    return { dot: 'game', service: 'game', slash: '' }
  }

  let dot = IDENTIFIER.test(service) ? `game.${service}` : `game[${quote(service)}]`
  for (const name of rest) {
    dot += IDENTIFIER.test(name) ? `.${name}` : `[${quote(name)}]`
  }

  let full = `game:GetService(${quote(service)})`
  for (const name of rest) {
    full += IDENTIFIER.test(name) ? `.${name}` : `:WaitForChild(${quote(name)})`
  }

  return { dot, service: full, slash: instancePath.join('/') }
}
