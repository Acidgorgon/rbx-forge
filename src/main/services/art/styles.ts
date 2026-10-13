import type { ArtStyleId, ArtStylePreset } from '../../../shared/artTypes.ts'

// Style presets: art direction appended to the prompt, plus a default size / background.
export const STYLE_PRESETS: ArtStylePreset[] = [
  { id: 'none', label: 'No preset', direction: '' },
  {
    id: 'roblox-ui-flat',
    label: 'Roblox UI flat',
    direction:
      'Flat game UI element for a Roblox experience: clean vector shapes, bold readable silhouette, thick dark outline, soft inner highlight, limited saturated palette, no text, no watermark, centered with even padding, crisp edges that read at small sizes on phones.',
    size: '1024x1024',
    transparent: true
  },
  {
    id: 'stylized-icon',
    label: 'Stylized icon',
    direction:
      'Stylized 3D-rendered game icon, chunky toy-like proportions, glossy materials, rim light, gentle top-left key light, strong silhouette, single object centered, no background clutter, no text.',
    size: '1024x1024',
    transparent: true
  },
  {
    id: 'cartoon-key-art',
    label: 'Cartoon key art',
    direction:
      'Vibrant cartoon key art in a polished Roblox promotional style: dynamic composition, expressive characters, saturated colors, cinematic lighting, depth and atmosphere, clear focal point.',
    size: '1536x1024'
  },
  {
    id: 'thumbnail-16x9',
    label: 'Thumbnail 16:9',
    direction:
      'Roblox experience thumbnail, 16:9, eye-catching at small sizes: one clear focal action, high contrast, bold colors, leave the lower third readable, no small text, no logos of other brands.',
    size: '1920x1088'
  },
  {
    id: 'game-icon-512',
    label: 'Game icon 512',
    direction:
      'Roblox experience icon: square, a single bold subject filling most of the frame, simple background with a strong color, very high contrast, readable at 64 px, no text.',
    size: '1024x1024'
  }
]

export function stylePreset(id: ArtStyleId | undefined): ArtStylePreset {
  return STYLE_PRESETS.find((s) => s.id === id) ?? STYLE_PRESETS[0]
}

export function fullPrompt(prompt: string, style: ArtStyleId | undefined, transparent: boolean): string {
  const p = stylePreset(style)
  const parts = [prompt.trim()]
  if (p.direction) parts.push(`Style: ${p.direction}`)
  if (transparent) parts.push('Transparent background, the subject isolated with no backdrop, no drop shadow on the ground.')
  return parts.join('\n\n')
}

// Short file-name slug from a prompt.
export function slugify(text: string, max = 40): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .split('-')
    .filter((w) => w && !['a', 'an', 'the', 'of', 'for', 'and', 'with', 'in', 'on'].includes(w))
    .join('-')
    .slice(0, max)
    .replace(/-+$/, '')
  return slug || 'concept'
}
