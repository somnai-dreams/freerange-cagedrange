import type {CssClassIndex, CssDeclaration} from './css.ts'

// Line-box containment: an inline-level box taller than its formatting context's strut grows the
// line whenever it is present — the state space is the content states of the context, and the
// claim is "prove the box fits the strut or mean the shift". Field-validated by three all-constant
// bugs in one small app: a padded capsule over the strut, an exact-strut box under
// vertical-align: middle, and a margin on an atomic inline (margin boxes participate in the line).
//
// The rule is deliberately metric-free and conservative: strut = font-size × line-height, the box
// presents max(content line, min-height, height) plus block padding, borders, and margins.
// top/bottom alignment fits when box ≤ strut (edge-to-edge is exact); middle/baseline alignment
// needs strict box < strut, because an equal box provably pushes descent past the strut, and a
// smaller one passes with the note that font descent metrics are not modeled.

export type LineBoxContainmentClaim = {
  name: string
  context: [string, ...string[]]
  inline: [string, ...string[]]
  assume: {contextFontSizePx: number | null}
}

export type LineBoxCheck =
  | {kind: 'pass'; claim: string; strutPx: number; boxPx: number; verticalAlign: string; note: string | null}
  | {
      kind: 'fail'
      claim: string
      strutPx: number
      boxPx: number
      verticalAlign: string
      contributions: string[]
    }
  | {kind: 'unknown'; claim: string; reason: string}

// A side's merged declarations plus the shadow set: get() returns the winning declaration,
// undefined when absent, or a string reason when any of the side's classes has the property
// shadowed by a rule the model could not follow.
type Merged = {
  get(property: string): CssDeclaration | undefined | string
  has(property: string): boolean
}

export function checkLineBoxContainment(claim: LineBoxContainmentClaim, index: CssClassIndex): LineBoxCheck {
  const unknown = (reason: string): LineBoxCheck => ({kind: 'unknown', claim: claim.name, reason})

  for (const className of [...claim.context, ...claim.inline]) {
    const taint = index.tainted.get(className)
    if (taint != null) return unknown(`class '${className}' cannot be resolved: ${taint}`)
    if (!index.classes.has(className) && !index.shadowed.has(className)) {
      return unknown(`class '${className}' is not declared in any discovered stylesheet`)
    }
  }
  const context = merge(claim.context, index)
  const inline = merge(claim.inline, index)
  if (typeof context === 'string') return unknown(context)
  if (typeof inline === 'string') return unknown(inline)

  // The strut: the context's font size and line height.
  const contextFontRaw = context.get('font-size')
  if (typeof contextFontRaw === 'string') return unknown(contextFontRaw)
  const contextFont = contextFontRaw == null ? null : parseLength(contextFontRaw.value)
  let contextFontPx: number
  if (contextFont?.unit === 'px') contextFontPx = contextFont.value
  else if (contextFontRaw == null && claim.assume.contextFontSizePx != null) {
    contextFontPx = claim.assume.contextFontSizePx
  } else if (contextFontRaw == null) {
    return unknown("the context declares no font-size; set assume.contextFontSizePx to the inherited value")
  } else {
    return unknown(`context font-size '${contextFontRaw.value}' is not a pixel length`)
  }

  const contextLineRaw = context.get('line-height')
  if (typeof contextLineRaw === 'string') return unknown(contextLineRaw)
  if (contextLineRaw == null || contextLineRaw.value === 'normal') {
    return unknown('the context line-height is normal or undeclared — the strut is font-metric-dependent')
  }
  const contextLine = parseLength(contextLineRaw.value)
  if (contextLine == null) return unknown(`context line-height '${contextLineRaw.value}' is not resolvable`)
  const strutPx = contextLine.unit === 'number'
    ? contextLine.value * contextFontPx
    : contextLine.unit === 'px'
      ? contextLine.value
      : contextLine.value * contextFontPx

  // The inline box's own font, for em resolution and inherited numeric line-height.
  const inlineFontRaw = inline.get('font-size')
  if (typeof inlineFontRaw === 'string') return unknown(inlineFontRaw)
  const inlineFont = inlineFontRaw == null ? null : parseLength(inlineFontRaw.value)
  let inlineFontPx: number
  if (inlineFontRaw == null) inlineFontPx = contextFontPx
  else if (inlineFont?.unit === 'px') inlineFontPx = inlineFont.value
  else if (inlineFont?.unit === 'em') inlineFontPx = inlineFont.value * contextFontPx
  else return unknown(`inline font-size '${inlineFontRaw.value}' is not resolvable`)

  const contributions: string[] = []
  const inlineLineRaw = inline.get('line-height')
  if (typeof inlineLineRaw === 'string') return unknown(inlineLineRaw)
  let contentLinePx: number
  if (inlineLineRaw == null) {
    // Numeric line-height inherits as a number and rescales; length line-height inherits computed.
    contentLinePx = contextLine.unit === 'number' ? contextLine.value * inlineFontPx : strutPx
    contributions.push(
      `content line ${pixels(contentLinePx)} (font-size ${pixels(inlineFontPx)} × inherited line-height`
        + `${contextLine.unit === 'number' ? ` ${contextLine.value}` : ''})`,
    )
  } else {
    const inlineLine = parseLength(inlineLineRaw.value)
    if (inlineLine == null || inlineLineRaw.value === 'normal') {
      return unknown(`inline line-height '${inlineLineRaw.value}' is not resolvable`)
    }
    contentLinePx = inlineLine.unit === 'number' || inlineLine.unit === 'em'
      ? inlineLine.value * inlineFontPx
      : inlineLine.value
    contributions.push(`content line ${pixels(contentLinePx)} (declared line-height)`)
  }

  let boxCore = contentLinePx
  for (const property of ['min-height', 'height'] as const) {
    const raw = inline.get(property)
    if (typeof raw === 'string') return unknown(raw)
    if (raw == null) continue
    const length = parseLength(raw.value)
    if (length == null) return unknown(`inline ${property} '${raw.value}' is not resolvable`)
    const px = length.unit === 'px' ? length.value : length.unit === 'em' ? length.value * inlineFontPx : null
    if (px == null) return unknown(`inline ${property} '${raw.value}' is not a length`)
    if (px > boxCore) {
      boxCore = px
      contributions.push(`${property} ${pixels(px)} raises the box`)
    }
  }

  const paddingBlock = blockSides(inline, 'padding', inlineFontPx)
  if (typeof paddingBlock === 'string') return unknown(paddingBlock)
  const borderBlock = borderSides(inline, inlineFontPx)
  if (typeof borderBlock === 'string') return unknown(borderBlock)
  const marginBlock = blockSides(inline, 'margin', inlineFontPx)
  if (typeof marginBlock === 'string') return unknown(marginBlock)
  if (paddingBlock !== 0) contributions.push(`block padding ${pixels(paddingBlock)}`)
  if (borderBlock !== 0) contributions.push(`block borders ${pixels(borderBlock)}`)
  if (marginBlock !== 0) contributions.push(`block margins ${pixels(marginBlock)} (margin boxes participate in the line)`)
  const boxPx = boxCore + paddingBlock + borderBlock + marginBlock

  const displayRaw = inline.get('display')
  if (typeof displayRaw === 'string') return unknown(displayRaw)
  if (displayRaw != null && !/^inline(-flex|-block|-grid)?$/.test(displayRaw.value)) {
    return unknown(`display '${displayRaw.value}' is not inline-level, so the line-box claim does not apply`)
  }

  const alignRaw = inline.get('vertical-align')
  if (typeof alignRaw === 'string') return unknown(alignRaw)
  const verticalAlign = alignRaw?.value ?? 'baseline'
  if (!['top', 'bottom', 'middle', 'baseline'].includes(verticalAlign)) {
    return unknown(`vertical-align '${verticalAlign}' is outside the modeled values (top, bottom, middle, baseline)`)
  }

  contributions.push(`strut ${pixels(strutPx)} (context font-size ${pixels(contextFontPx)}`
    + `${contextLine.unit === 'number' ? ` × line-height ${contextLine.value}` : ''})`)

  const epsilon = 0.005
  if (boxPx > strutPx + epsilon) {
    return {kind: 'fail', claim: claim.name, strutPx, boxPx, verticalAlign, contributions}
  }
  if (Math.abs(boxPx - strutPx) <= epsilon) {
    if (verticalAlign === 'top' || verticalAlign === 'bottom') {
      return {kind: 'pass', claim: claim.name, strutPx, boxPx, verticalAlign, note: 'edge-aligned exact fit'}
    }
    contributions.push('the box equals the strut: middle/baseline alignment pushes descent past it')
    return {kind: 'fail', claim: claim.name, strutPx, boxPx, verticalAlign, contributions}
  }
  return {
    kind: 'pass',
    claim: claim.name,
    strutPx,
    boxPx,
    verticalAlign,
    note: verticalAlign === 'top' || verticalAlign === 'bottom'
      ? null
      : 'descent metrics are not modeled; a tight baseline fit can still overhang',
  }
}

// Merge a class list's declarations. Two classes declaring the same property resolve like the
// cascade only when both declarations sit in the same stylesheet (order decides); across files
// the load order is unknown and the claim must say so.
function merge(classNames: readonly string[], index: CssClassIndex): Merged | string {
  const declarations = new Map<string, CssDeclaration>()
  for (const className of classNames) {
    for (const [property, declaration] of index.classes.get(className) ?? new Map<string, CssDeclaration>()) {
      const previous = declarations.get(property)
      if (previous == null) {
        declarations.set(property, declaration)
        continue
      }
      if (previous.file !== declaration.file) {
        return `'${property}' is declared by more than one of the claim's classes across different stylesheets; load order is unknown`
      }
      const winner = declaration.important === previous.important
        ? declaration.order >= previous.order ? declaration : previous
        : declaration.important ? declaration : previous
      declarations.set(property, winner)
    }
  }
  const shadows = new Map<string, string>()
  for (const className of classNames) {
    for (const [property, reason] of index.shadowed.get(className) ?? new Map<string, string>()) {
      if (!shadows.has(property)) shadows.set(property, `'${property}' on '${className}' is ${reason}`)
    }
  }
  return {
    get: (property: string) => shadows.get(property) ?? declarations.get(property),
    has: (property: string) => shadows.has(property) || declarations.has(property),
  }
}

type Length = {value: number; unit: 'px' | 'em' | 'number'}

function parseLength(raw: string): Length | null {
  const trimmed = raw.trim()
  let match = trimmed.match(/^(-?\d+(?:\.\d+)?)px$/)
  if (match != null) return {value: Number(match[1]), unit: 'px'}
  match = trimmed.match(/^(-?\d+(?:\.\d+)?)em$/)
  if (match != null) return {value: Number(match[1]), unit: 'em'}
  match = trimmed.match(/^(-?\d+(?:\.\d+)?)$/)
  if (match != null) return {value: Number(match[1]), unit: 'number'}
  return null
}

// Block-axis (top + bottom) total for padding or margin: shorthand and longhands compete by the
// same importance-then-order rule the cascade uses within one stylesheet.
function blockSides(merged: Merged, family: 'padding' | 'margin', fontPx: number): number | string {
  let total = 0
  for (const side of ['top', 'bottom'] as const) {
    const candidates: Array<{declaration: CssDeclaration; text: string}> = []
    const shorthand = merged.get(family)
    if (typeof shorthand === 'string') return shorthand
    if (shorthand != null) {
      const sides = expandBox(shorthand.value)
      if (sides == null) return `${family} '${shorthand.value}' is not resolvable`
      candidates.push({declaration: shorthand, text: sides[side]})
    }
    const longhand = merged.get(`${family}-${side}`)
    if (typeof longhand === 'string') return longhand
    if (longhand != null) candidates.push({declaration: longhand, text: longhand.value})
    if (candidates.length === 0) continue
    candidates.sort((left, right) =>
      left.declaration.important === right.declaration.important
        ? left.declaration.order - right.declaration.order
        : left.declaration.important ? 1 : -1)
    const winner = candidates[candidates.length - 1]!
    const length = parseLength(winner.text)
    const px = length == null
      ? null
      : length.unit === 'px' || (length.unit === 'number' && length.value === 0)
        ? length.value
        : length.unit === 'em' ? length.value * fontPx : null
    if (px == null) return `${family}-${side} '${winner.text}' is not resolvable`
    total += px
  }
  return total
}

function borderSides(merged: Merged, fontPx: number): number | string {
  let total = 0
  for (const side of ['top', 'bottom'] as const) {
    const candidates: Array<{declaration: CssDeclaration; text: string}> = []
    const border = merged.get('border')
    if (typeof border === 'string') return border
    if (border != null) {
      const width = border.value.split(/\s+/).find(token => parseLength(token) != null)
      candidates.push({declaration: border, text: width ?? '0'})
    }
    const widthShorthand = merged.get('border-width')
    if (typeof widthShorthand === 'string') return widthShorthand
    if (widthShorthand != null) {
      const sides = expandBox(widthShorthand.value)
      if (sides == null) return `border-width '${widthShorthand.value}' is not resolvable`
      candidates.push({declaration: widthShorthand, text: sides[side]})
    }
    const longhand = merged.get(`border-${side}-width`) ?? merged.get(`border-${side}`)
    if (typeof longhand === 'string') return longhand
    if (longhand != null) {
      const width = longhand.value.split(/\s+/).find(token => parseLength(token) != null)
      candidates.push({declaration: longhand, text: width ?? longhand.value})
    }
    if (candidates.length === 0) continue
    candidates.sort((left, right) =>
      left.declaration.important === right.declaration.important
        ? left.declaration.order - right.declaration.order
        : left.declaration.important ? 1 : -1)
    const winner = candidates[candidates.length - 1]!
    const length = parseLength(winner.text)
    const px = length == null
      ? null
      : length.unit === 'px' || (length.unit === 'number' && length.value === 0)
        ? length.value
        : length.unit === 'em' ? length.value * fontPx : null
    if (px == null) return `border width '${winner.text}' is not resolvable`
    total += px
  }
  return total
}

function expandBox(raw: string): {top: string; bottom: string} | null {
  const parts = raw.trim().split(/\s+/)
  if (parts.length === 1) return {top: parts[0]!, bottom: parts[0]!}
  if (parts.length === 2 || parts.length === 3) return {top: parts[0]!, bottom: parts[parts.length === 2 ? 0 : 2]!}
  if (parts.length === 4) return {top: parts[0]!, bottom: parts[2]!}
  return null
}

export function pixels(value: number): string {
  return `${Number(value.toFixed(2))}px`
}
