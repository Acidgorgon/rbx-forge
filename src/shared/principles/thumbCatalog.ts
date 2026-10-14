// Thumbnail principles (Thumbnail Lab): what makes an experience thumbnail get clicked on Roblox's
// discovery surfaces, and what keeps it honest. Same shape as the animation / VFX catalogues; the
// critic scores them, the code checks (shared/thumbs/checks.ts) measure the ones marked `measure`.
//
// Roblox facts (Creator Hub, "Thumbnails", create.roblox.com/docs/production/promotion/thumbnails,
// read 2026-10-14): ideally 1920x1080, shown stretched to 16:9; "Graphics shown must be
// representative of the actual in-game visuals"; "Do not display gameplay mechanics, UI elements, or
// interactions that are not actually available in your game"; "Overlay text sparingly"; "avoid
// placing any essential text or elements at the bottom of the thumbnail"; a thumbnail "will have a
// higher impact if it's unique and provides relevant imagery".

import type { Principle } from './types.ts'

export const THUMB_PRINCIPLES: Principle[] = [
  {
    id: 'th-readable',
    domain: 'thumb',
    name: 'Readable at small size',
    rule: 'The idea reads at phone size: big shapes, hard edges, nothing that needs zooming in.',
    roblox: 'Discovery tiles are small (think 160-256 px wide on phones). Check the 160x90 render: outlined subjects and thick lettering survive, fine detail and thin text turn to mush.',
    good: 'At 160x90 you still see a character, a giant enemy and the word "BOSS".',
    bad: 'A wide scenic shot with tiny characters and a small thin title that vanishes when shrunk.',
    measure: 'edge crispness after the 256x144 and 160x90 downscale (legibility proxy) and detail kept',
    plan: null,
    kinds: 'all',
    base: 1.4,
    words: /readab|small|tiny|can'?t see|blur|mush|phone|zoom/i
  },
  {
    id: 'th-focal',
    domain: 'thumb',
    name: 'One focal point',
    rule: 'One subject owns the frame; everything else supports it.',
    roblox: 'Players scan a grid of tiles in a fraction of a second: one face, one weapon or one monster, large and near the centre or a third line, with a simple backdrop.',
    good: 'A close-up character reacting, the threat behind them, the backdrop blurred.',
    bad: 'Five characters, a map, coins and UI all the same size and brightness.',
    measure: 'saliency of the strongest region versus the rest (6x4 grid), competing regions, clutter',
    plan: null,
    kinds: 'all',
    base: 1.3,
    words: /focal|focus|busy|clutter|too much|messy|where do i look|crowded/i
  },
  {
    id: 'th-contrast',
    domain: 'thumb',
    name: 'Contrast and separation',
    rule: 'The subject separates from the background by value, colour and an outline or rim light.',
    roblox: 'Roblox lighting is often flat: add rim light, a dark-to-bright backdrop or an outline so the character does not melt into the map.',
    good: 'A bright character with a white rim light against a dark, saturated backdrop.',
    bad: 'Mid-grey character on a mid-grey street; the silhouette disappears.',
    measure: 'RMS luma contrast of the frame',
    plan: null,
    kinds: 'all',
    base: 1.1,
    words: /contrast|flat|dull|muddy|blend|separat|outline|rim/i
  },
  {
    id: 'th-text',
    domain: 'thumb',
    name: 'Text: three words or fewer',
    rule: 'No text, or about three big words that add something the picture cannot say.',
    roblox: 'Overlay text sparingly (Creator Hub). The experience title already sits under the tile, so do not repeat it; avoid ads, claims and "BEST GAME EVER" style text.',
    good: '"1000 STUDS DEEP" in thick outlined letters across the top third.',
    bad: 'A sentence of small text, or the game\'s full name again, or "UPDATE!! FREE ROBUX".',
    measure: null,
    plan: null,
    kinds: 'all',
    base: 1,
    words: /text|words|title|font|letters|caption/i
  },
  {
    id: 'th-emotion',
    domain: 'thumb',
    name: 'Faces and emotion',
    rule: 'A readable face or reaction gives the tile a feeling (fear, surprise, triumph) and a story.',
    roblox: 'Blocky avatars carry emotion through big expressive faces, poses and a clear reaction to the threat or reward in frame.',
    good: 'A shocked avatar face in the foreground, a huge monster looming behind.',
    bad: 'A distant avatar seen from behind standing still.',
    measure: null,
    plan: null,
    kinds: 'all',
    base: 1,
    words: /face|emotion|expression|reaction|boring|shock|scared/i
  },
  {
    id: 'th-pop',
    domain: 'thumb',
    name: 'Colour pop on the discovery page',
    rule: 'Saturated, distinct colours that stand apart from the page and from the tiles around it, in both themes.',
    roblox: 'The tile sits on Roblox\'s dark or light page next to many other bright tiles: a near-black or near-white frame edge melts into one of the themes.',
    good: 'Saturated orange and teal with a strong value range; the edges are neither page-black nor page-white.',
    bad: 'A dark navy night scene that disappears on the dark theme.',
    measure: 'colour distance from the dark and light page backgrounds and colourfulness, at 160x90',
    plan: null,
    kinds: 'all',
    base: 1,
    words: /colou?r|pop|saturat|vibrant|bright|stand out|grey|gray|washed/i
  },
  {
    id: 'th-honest',
    domain: 'thumb',
    name: 'Honest to the game',
    rule: 'Shows what the experience really looks like and lets you do; nothing borrowed from other games.',
    roblox: 'Creator Hub: graphics must be representative of the actual in-game visuals, with no mechanics, UI or interactions that are not in the game. Built from the game\'s own screenshots; never another game\'s characters, logos or text.',
    good: 'The real map and avatars from a Studio capture, dramatised with lighting, framing and effects.',
    bad: 'A character or logo from another popular game, or a boss fight that does not exist.',
    measure: null,
    plan: null,
    kinds: 'all',
    base: 1.3,
    words: /honest|mislead|fake|clickbait|not in the game|copy|copied|stolen|logo/i
  },
  {
    id: 'th-safe-area',
    domain: 'thumb',
    name: 'Bottom edge clear',
    rule: 'Nothing essential in the bottom strip of the frame.',
    roblox: 'Creator Hub: "avoid placing any essential text or elements at the bottom of the thumbnail" (overlays such as player counts and ratings sit there).',
    good: 'Title text across the top third, the subject centred, the bottom 15% is backdrop.',
    bad: 'The only text of the tile runs along the bottom edge.',
    measure: 'share of the frame\'s visual weight in the bottom 15%',
    plan: null,
    kinds: 'all',
    base: 0.7,
    words: /bottom|cut off|covered|overlay/i
  }
]
