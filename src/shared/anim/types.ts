export interface AnimMarker { name: string; t: number }
export interface AnimClipRef { id: string; name: string; duration: number; looped: boolean; markers: AnimMarker[]; scope: 'user' | 'project' }
