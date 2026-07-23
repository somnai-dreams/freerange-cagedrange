// The Tailwind model, in one place: token classification, the default pixel scale, edge
// spreads, responsive gates, variant taxonomy, transform sign canonicalization, and declaration
// synthesis for bare utilities. Every consumer — the state-geometry scan, the breakpoint report,
// line-box containment claims — reads Tailwind through this module, so the knowledge cannot
// drift between them, and a ground-truth backend (compiling the project's real Tailwind config)
// would plug in here without touching any consumer.
//
// Values encode Tailwind's DEFAULTS: the 4px spacing scale, standard screens, the text sizes
// with their paired line heights, utility layer ordering. A project with a custom theme is
// outside this model — reports that rest on it say so as an assumption.

export const edgeNames = ['left', 'right', 'top', 'bottom'] as const

export type TokenClassification = {
  kind: 'geometry' | 'paint' | 'unknown'
  family: string
  value: string
  variants: string[]
  important: boolean
}

export const displayUtilities = new Set(['block', 'inline', 'inline-block', 'inline-flex', 'inline-grid', 'flex', 'grid', 'hidden', 'contents', 'table'])
export const positionUtilities = new Set(['absolute', 'relative', 'fixed', 'sticky', 'static'])
export const fontSizeScale = new Set(['xs', 'sm', 'base', 'lg', 'xl', '2xl', '3xl', '4xl', '5xl', '6xl', '7xl', '8xl', '9xl'])
export const paintRoots = new Set(['bg', 'rounded', 'ring', 'outline', 'shadow', 'opacity', 'fill', 'stroke', 'decoration', 'divide', 'accent', 'caret', 'from', 'via', 'to'])
export const spacingRoots = new Set(['p', 'px', 'py', 'pt', 'pr', 'pb', 'pl', 'ps', 'pe', 'm', 'mx', 'my', 'mt', 'mr', 'mb', 'ml', 'ms', 'me', 'gap', 'gap-x', 'gap-y', 'space-x', 'space-y', 'w', 'h', 'size', 'min-w', 'min-h', 'max-w', 'max-h', 'inset', 'inset-x', 'inset-y', 'top', 'right', 'bottom', 'left', 'start', 'end', 'leading', 'basis', 'indent', 'translate-x', 'translate-y'])

export function classifyToken(rawToken: string): TokenClassification {
  const segments = rawToken.split(':')
  let utility = segments[segments.length - 1]!
  const variants = segments.slice(0, -1)
  let important = false
  if (utility.endsWith('!')) {
    important = true
    utility = utility.slice(0, -1)
  } else if (utility.startsWith('!')) {
    important = true
    utility = utility.slice(1)
  }
  const negative = utility.startsWith('-')
  const bare = negative ? utility.slice(1) : utility

  if (displayUtilities.has(bare)) return {kind: 'geometry', family: 'display', value: bare, variants, important}
  if (positionUtilities.has(bare)) return {kind: 'geometry', family: 'position', value: bare, variants, important}
  if (bare.startsWith('aspect-')) {
    // aspect-ratio couples inline size to block size: a reflow lever with no length token.
    return {kind: 'geometry', family: 'aspect', value: bare.slice('aspect-'.length), variants, important}
  }
  if (bare === 'grow' || bare === 'shrink' || bare === 'flex-1' || bare === 'flex-auto' || bare === 'flex-none' || bare === 'flex-initial') {
    return {kind: 'geometry', family: 'flex', value: bare, variants, important}
  }

  const dash = bare.indexOf('-')
  const root = dash === -1 ? bare : bare.slice(0, dash)
  const value = dash === -1 ? '' : bare.slice(dash + 1)

  if (root === 'border') {
    // 'border', 'border-2', 'border-t', 'border-t-2', 'border-[3px]' are widths (geometry);
    // 'border-transparent', 'border-red-500/50', 'border-t-light-100' are colors (paint);
    // 'border-solid'/'border-dashed' are style (paint: no layout effect once width is set).
    const parts = value === '' ? [] : value.split('-')
    const edge = parts.length > 0 && /^(t|r|b|l|x|y|s|e)$/.test(parts[0]!) ? parts.shift()! : ''
    const remainder = parts.join('-')
    if (remainder === '' || /^\d+$/.test(remainder) || /^\[\d+(px|rem|em)\]$/.test(remainder)) {
      return {kind: 'geometry', family: `border-width${edge === '' ? '' : `-${edge}`}`, value: remainder === '' ? '1' : remainder, variants, important}
    }
    if (/^(solid|dashed|dotted|double|none|hidden)$/.test(remainder)) {
      return {kind: 'paint', family: 'border-style', value: remainder, variants, important}
    }
    return {kind: 'paint', family: 'border-color', value: remainder, variants, important}
  }
  if (root === 'text') {
    if (fontSizeScale.has(value) || /^\[\d+(px|rem|em)\]$/.test(value)) {
      return {kind: 'geometry', family: 'font-size', value, variants, important}
    }
    return {kind: 'paint', family: 'text-color', value, variants, important}
  }
  if (spacingRoots.has(root) || spacingRoots.has(`${root}-${value.split('-')[0] ?? ''}`)) {
    const composite = spacingRoots.has(`${root}-${value.split('-')[0] ?? ''}`) ? `${root}-${value.split('-')[0]}` : root
    const amount = composite === root ? value : value.split('-').slice(1).join('-')
    return {kind: 'geometry', family: `${negative ? '-' : ''}${composite}`, value: amount, variants, important}
  }
  if (paintRoots.has(root)) return {kind: 'paint', family: root, value, variants, important}
  return {kind: 'unknown', family: root, value, variants, important}
}

// Tailwind's default numeric scale is 4px per step; border widths default to 1px. Values outside
// the modeled forms return null and stay categorical rather than being guessed.
export function pixelsOf(family: string, value: string): number | null {
  const bareFamily = family.startsWith('-') ? family.slice(1) : family
  if (bareFamily.startsWith('border-width')) {
    if (value === '' || value === '1') return value === '' ? 1 : 1
    if (/^\d+$/.test(value)) return Number(value)
    const arbitrary = /^\[(\d+(?:\.\d+)?)px\]$/.exec(value)
    return arbitrary == null ? null : Number(arbitrary[1])
  }
  if (value === 'px') return 1
  if (/^\d+(\.\d+)?$/.test(value)) return Number(value) * 4
  const arbitraryPx = /^\[(\d+(?:\.\d+)?)px\]$/.exec(value)
  if (arbitraryPx != null) return Number(arbitraryPx[1])
  const arbitraryRem = /^\[(\d+(?:\.\d+)?)rem\]$/.exec(value)
  if (arbitraryRem != null) return Number(arbitraryRem[1]) * 16
  return null
}

export type EdgeSpread = {
  group: 'border' | 'padding' | 'margin'
  edges: readonly (typeof edgeNames)[number][]
  negative: boolean
}

export function edgeSpread(family: string): EdgeSpread | null {
  const negative = family.startsWith('-')
  const bare = negative ? family.slice(1) : family
  const insetMap: Record<string, readonly (typeof edgeNames)[number][]> = {
    'border-width': edgeNames, 'border-width-x': ['left', 'right'], 'border-width-y': ['top', 'bottom'],
    'border-width-l': ['left'], 'border-width-r': ['right'], 'border-width-t': ['top'], 'border-width-b': ['bottom'],
    'border-width-s': ['left'], 'border-width-e': ['right'],
    p: edgeNames, px: ['left', 'right'], py: ['top', 'bottom'],
    pl: ['left'], pr: ['right'], pt: ['top'], pb: ['bottom'], ps: ['left'], pe: ['right'],
  }
  const marginMap: Record<string, readonly (typeof edgeNames)[number][]> = {
    m: edgeNames, mx: ['left', 'right'], my: ['top', 'bottom'],
    ml: ['left'], mr: ['right'], mt: ['top'], mb: ['bottom'], ms: ['left'], me: ['right'],
  }
  const inset = insetMap[bare]
  if (inset != null) {
    return {group: bare.startsWith('border') ? 'border' : 'padding', edges: inset, negative}
  }
  const margin = marginMap[bare]
  if (margin != null) return {group: 'margin', edges: margin, negative}
  return null
}

export const tailwindScreens: Record<string, number> = {sm: 640, md: 768, lg: 1024, xl: 1280, '2xl': 1536}

// A responsive variant gates a token to a width interval: min-style (sm, md, min-[Npx]) applies
// at and above the threshold, max-style below it — Tailwind's max-md is width < 768px.
export function responsiveGate(variant: string): {kind: 'min' | 'max'; px: number} | null {
  const bare = variant.startsWith('max-') ? variant.slice(4) : variant
  const screen = tailwindScreens[bare]
  if (screen != null) return {kind: variant.startsWith('max-') ? 'max' : 'min', px: screen}
  const arbitrary = /^(min|max)-\[(\d+(?:\.\d+)?)px\]$/.exec(variant)
  if (arbitrary != null) return {kind: arbitrary[1] as 'min' | 'max', px: Number(arbitrary[2])}
  return null
}

export const stateVariantPattern = /^(hover|focus|focus-visible|focus-within|active|visited|disabled|checked|open|group-[\w[\]=-]+|peer-[\w[\]=-]+|data-\[[^\]]+\]|aria-\[[^\]]+\])$/

// Transform families move pixels on screen without entering layout: neighbors never reflow, so a
// difference confined to them is motion, not displacement. Negative-value spellings keep the
// leading dash in the family name.
export const transformFamilyPattern = /^-?(translate(-[xyz])?|scale(-[xy])?|rotate(-[xyz])?|skew(-[xy])?)$/

// Sign-symmetric transform utilities split into two spellings (-translate-x-14 vs
// translate-x-14) whose families never compared, silently skipping real state differences.
// The comparison surfaces canonicalize to the bare family with the sign folded into the value.
export function canonicalTransform(family: string): {family: string; sign: 1 | -1} | null {
  if (!transformFamilyPattern.test(family)) return null
  return family.startsWith('-') ? {family: family.slice(1), sign: -1} : {family, sign: 1}
}

export function transformOnlyFamilies(families: Iterable<string>): boolean {
  let any = false
  for (const family of families) {
    any = true
    if (!transformFamilyPattern.test(family)) return false
  }
  return any
}

// A synthesized declaration mirrors a stylesheet declaration's shape so claim evaluation treats
// both sources uniformly; the synthetic file name makes utility-versus-stylesheet conflicts read
// as what they are.
export type TailwindDeclaration = {
  value: string
  important: boolean
  order: number
  file: string
}

// Tailwind's default scale, as synthesized declarations for claim classes no stylesheet
// declares. Deliberately the same bounded vocabulary the state-geometry scan evaluates —
// spacing-scale margins and paddings (fractional and arbitrary values included), heights,
// leading, the default text sizes with their paired line heights, display, alignment, and
// borders. The synthetic file name makes a conflict with a real stylesheet read as what it is:
// utility-versus-stylesheet order, which is not statically knowable.
export const tailwindFile = 'tailwind defaults'

const namedLeading = new Map<string, string>([
  ['none', '1'], ['tight', '1.25'], ['snug', '1.375'],
  ['normal', '1.5'], ['relaxed', '1.625'], ['loose', '2'],
])

const textSizes = new Map<string, {fontPx: number; line: string}>([
  ['xs', {fontPx: 12, line: '16px'}], ['sm', {fontPx: 14, line: '20px'}],
  ['base', {fontPx: 16, line: '24px'}], ['lg', {fontPx: 18, line: '28px'}],
  ['xl', {fontPx: 20, line: '28px'}], ['2xl', {fontPx: 24, line: '32px'}],
  ['3xl', {fontPx: 30, line: '36px'}], ['4xl', {fontPx: 36, line: '40px'}],
  ['5xl', {fontPx: 48, line: '1'}], ['6xl', {fontPx: 60, line: '1'}],
  ['7xl', {fontPx: 72, line: '1'}], ['8xl', {fontPx: 96, line: '1'}],
  ['9xl', {fontPx: 128, line: '1'}],
])

const verticalAlignUtilities = new Map<string, string>([
  ['align-baseline', 'baseline'], ['align-top', 'top'],
  ['align-middle', 'middle'], ['align-bottom', 'bottom'],
])

export function synthesizeTailwindClass(name: string): Map<string, TailwindDeclaration> | null {
  // Orders encode Tailwind's own utility layering, so `text-sm leading-none` resolves the
  // line-height conflict the way the emitted stylesheet does: leading utilities come after
  // font-size utilities and win.
  const declare = (entries: Array<[string, string]>, baseOrder = 30): Map<string, TailwindDeclaration> =>
    new Map(entries.map(([property, value], offset) =>
      [property, {value, important: false, order: baseOrder + offset, file: tailwindFile}]))

  if (displayUtilities.has(name)) return declare([['display', name]])
  const align = verticalAlignUtilities.get(name)
  if (align != null) return declare([['vertical-align', align]])
  if (name === 'border') return declare([['border-width', '1px']])

  const parsed = classifyToken(name)
  if (parsed.variants.length > 0 || parsed.kind !== 'geometry') return null
  const magnitude = pixelsOf(parsed.family, parsed.value)
  const bare = parsed.family.replace(/^-/, '')
  const signed = (px: number): string => `${parsed.family.startsWith('-') ? -px : px}px`

  if (bare === 'font-size') {
    const size = textSizes.get(parsed.value)
    return size == null ? null : declare([['font-size', `${size.fontPx}px`], ['line-height', size.line]], 10)
  }
  if (bare === 'leading') {
    const named = namedLeading.get(parsed.value)
    if (named != null) return declare([['line-height', named]], 20)
    return magnitude == null ? null : declare([['line-height', `${magnitude}px`]], 20)
  }
  if (magnitude == null) return null
  const blockSpread: Record<string, string[]> = {
    'm': ['margin-top', 'margin-bottom'], 'my': ['margin-top', 'margin-bottom'],
    'mt': ['margin-top'], 'mb': ['margin-bottom'],
    'p': ['padding-top', 'padding-bottom'], 'py': ['padding-top', 'padding-bottom'],
    'pt': ['padding-top'], 'pb': ['padding-bottom'],
    'h': ['height'], 'min-h': ['min-height'],
    'border-width': ['border-top-width', 'border-bottom-width'],
  }
  const properties = blockSpread[bare]
  if (properties == null) return null
  return declare(properties.map(property => [property, signed(magnitude)]))
}
