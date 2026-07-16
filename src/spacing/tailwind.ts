import type {
  ClassFact,
  DeclarationCondition,
  DeclarationTarget,
  OffsetProperty,
  SpacingAmount,
  SpacingAxis,
} from './model.ts'

// Variants that style a different box than the element carrying the className.
const pseudoElementVariants = new Set([
  'before', 'after', 'placeholder', 'selection', 'marker', 'backdrop', 'file',
  'first-letter', 'first-line',
])

export function parseTailwindClass(rawToken: string): ClassFact | null {
  const {utility: unprefixed, variants} = splitVariants(rawToken)
  const target: DeclarationTarget = variants.some(variant =>
    pseudoElementVariants.has(variant) || variant.startsWith('['))
    ? 'other'
    : 'self'
  const condition: DeclarationCondition = variants.length === 0 ? 'always' : 'conditional'
  let utility = unprefixed
  if (utility.startsWith('!')) utility = utility.slice(1)
  if (utility.endsWith('!')) utility = utility.slice(0, -1)

  switch (utility) {
    case 'absolute':
    case 'fixed':
      return {kind: 'position', token: rawToken, status: 'outOfFlow', target, condition}
    case 'relative':
    case 'sticky':
      return {kind: 'position', token: rawToken, status: 'positionedInFlow', target, condition}
    case 'static':
      return {kind: 'position', token: rawToken, status: 'none', target, condition}
    default: break
  }

  let negative = false
  if (utility.startsWith('-')) {
    negative = true
    utility = utility.slice(1)
  }

  const offsetProperties = offsetUtilityProperties(utility)
  if (offsetProperties != null) {
    return {kind: 'offset', token: rawToken, properties: offsetProperties, target, condition}
  }

  const parsed = parseSpacingUtility(utility)
  if (parsed == null) {
    if (dialectInertUtility(utility)) return null
    return {kind: 'unmodeled', token: rawToken, target, condition, resembles: unmodeledResemblance(utility)}
  }
  return {
    kind: parsed.kind,
    token: rawToken,
    axis: parsed.axis,
    amount: classAmount(parsed.value, negative),
    target,
    condition,
  }
}

function parseSpacingUtility(
  utility: string,
): {axis: SpacingAxis | 'both'; kind: 'margin' | 'padding' | 'gap'; value: string} | null {
  if (hasUtilityRoot(utility, 'gap-x')) return knownSpacingValue(utility.slice(6), 'horizontal', 'gap')
  if (hasUtilityRoot(utility, 'gap-y')) return knownSpacingValue(utility.slice(6), 'vertical', 'gap')
  if (hasUtilityRoot(utility, 'space-x')) {
    const value = utility.slice(8)
    return value === 'reverse' ? null : knownSpacingValue(value, 'horizontal', 'gap')
  }
  if (hasUtilityRoot(utility, 'space-y')) {
    const value = utility.slice(8)
    return value === 'reverse' ? null : knownSpacingValue(value, 'vertical', 'gap')
  }
  const root = utilityRoot(utility)
  if (root == null) return null
  const value = utilityValue(utility)
  if (value == null) return null
  switch (root) {
    case 'gap': return knownSpacingValue(value, 'both', 'gap')
    case 'p': return knownSpacingValue(value, 'both', 'padding')
    case 'pt':
    case 'pb':
    case 'py': return knownSpacingValue(value, 'vertical', 'padding')
    case 'pl':
    case 'pr':
    case 'px':
    case 'ps':
    case 'pe': return knownSpacingValue(value, 'horizontal', 'padding')
    default: {
      const marginAxis = marginUtilityAxis(utility)
      if (marginAxis == null) return null
      return knownSpacingValue(value, marginAxis, 'margin')
    }
  }
}

function knownSpacingValue(
  value: string,
  axis: SpacingAxis | 'both',
  kind: 'margin' | 'padding' | 'gap',
): {axis: SpacingAxis | 'both'; kind: 'margin' | 'padding' | 'gap'; value: string} | null {
  return isKnownTailwindLength(value) ? {axis, kind, value} : null
}

function classAmount(value: string, negative: boolean): SpacingAmount {
  const sign = negative ? -1 : 1
  if (/^\d+(\.\d+)?$/.test(value)) return {form: 'tailwindScale', steps: sign * Number(value)}
  if (value === 'px') return {form: 'length', value: sign, unit: 'px'}
  if (value.startsWith('[') && value.endsWith(']')) {
    const content = value.slice(1, -1)
    const pxMatch = /^(-?\d+(\.\d+)?)px$/.exec(content)
    if (pxMatch != null) return {form: 'length', value: sign * Number(pxMatch[1]), unit: 'px'}
    const remMatch = /^(-?\d+(\.\d+)?)rem$/.exec(content)
    if (remMatch != null) return {form: 'length', value: sign * Number(remMatch[1]), unit: 'rem'}
    return {form: 'keyword', text: signedKeyword(content, negative)}
  }
  return {form: 'keyword', text: signedKeyword(value, negative)}
}

function signedKeyword(value: string, negative: boolean): string {
  if (!negative) return value
  if (value.startsWith('-')) return value.slice(1)
  if (value.startsWith('+')) return `-${value.slice(1)}`
  return `-${value}`
}

function marginUtilityAxis(utility: string): SpacingAxis | 'both' | null {
  const root = utilityRoot(utility)
  if (root == null || utilityValue(utility) === 'auto') return null
  switch (root) {
    case 'm': return 'both'
    case 'mt':
    case 'mb':
    case 'my': return 'vertical'
    case 'ml':
    case 'mr':
    case 'mx':
    case 'ms':
    case 'me': return 'horizontal'
    default: return null
  }
}

function offsetUtilityProperties(utility: string): OffsetProperty[] | null {
  if (hasUtilityRoot(utility, 'inset-y')) return knownOffset(utility.slice(8), ['top', 'bottom'])
  if (hasUtilityRoot(utility, 'inset-x')) return knownOffset(utility.slice(8), ['left', 'right'])
  if (hasUtilityRoot(utility, 'inset-s')) return knownOffset(utility.slice(8), ['inlineStart'])
  if (hasUtilityRoot(utility, 'inset-e')) return knownOffset(utility.slice(8), ['inlineEnd'])
  if (hasUtilityRoot(utility, 'inset-bs')) return knownOffset(utility.slice(9), ['blockStart'])
  if (hasUtilityRoot(utility, 'inset-be')) return knownOffset(utility.slice(9), ['blockEnd'])
  if (hasUtilityRoot(utility, 'inset')) return knownOffset(utility.slice(6), ['top', 'bottom', 'left', 'right'])
  const root = utilityRoot(utility)
  const value = utilityValue(utility)
  if (root == null || value == null || !isKnownTailwindLength(value)) return null
  switch (root) {
    case 'top':
    case 'bottom':
    case 'left':
    case 'right': return [root]
    case 'start': return ['inlineStart']
    case 'end': return ['inlineEnd']
    default: return null
  }
}

function knownOffset(value: string, properties: OffsetProperty[]): OffsetProperty[] | null {
  return isKnownTailwindLength(value) ? properties : null
}

function isKnownTailwindLength(value: string): boolean {
  return /^\d+(\.\d+)?$/.test(value)
    || /^\d+\/\d+$/.test(value)
    || value === 'px'
    || value === 'auto'
    || value === 'full'
    || (value.startsWith('[') && value.endsWith(']'))
}

// Utilities the dialect recognizes that carry no ownership fact: an auto margin is
// alignment rather than a spacing amount, and the space-*-reverse switches only flip
// which sibling receives the existing space. Treating them as unmodeled would falsely
// claim that external CSS may be involved and would stand real findings down.
function dialectInertUtility(utility: string): boolean {
  if (utility === 'space-x-reverse' || utility === 'space-y-reverse') return true
  if (utilityValue(utility) !== 'auto') return false
  switch (utilityRoot(utility)) {
    case 'm':
    case 'mt':
    case 'mb':
    case 'ml':
    case 'mr':
    case 'mx':
    case 'my':
    case 'ms':
    case 'me': return true
    default: return false
  }
}

// A root is read up to the first dash, so the multi-segment families are matched on the
// whole utility first; 'space-y-huge' resembles spacing even though its first segment
// alone matches nothing.
function unmodeledResemblance(utility: string): 'offset' | 'spacing' | 'other' {
  if (hasUtilityRoot(utility, 'inset')) return 'offset'
  if (hasUtilityRoot(utility, 'gap')
    || hasUtilityRoot(utility, 'space-x')
    || hasUtilityRoot(utility, 'space-y')) return 'spacing'
  const root = utilityRoot(utility)
  switch (root) {
    case 'top':
    case 'bottom':
    case 'left':
    case 'right':
    case 'start':
    case 'end': return 'offset'
    case 'm':
    case 'mt':
    case 'mb':
    case 'ml':
    case 'mr':
    case 'mx':
    case 'my':
    case 'ms':
    case 'me':
    case 'p':
    case 'pt':
    case 'pb':
    case 'pl':
    case 'pr':
    case 'px':
    case 'py':
    case 'ps':
    case 'pe': return 'spacing'
    default: return 'other'
  }
}

function splitVariants(token: string): {utility: string; variants: string[]} {
  const segments: string[] = []
  let bracketDepth = 0
  let segmentStart = 0
  for (let index = 0; index < token.length; index++) {
    const character = token[index]!
    if (character === '[') bracketDepth++
    else if (character === ']') bracketDepth = Math.max(0, bracketDepth - 1)
    else if (character === ':' && bracketDepth === 0) {
      segments.push(token.slice(segmentStart, index))
      segmentStart = index + 1
    }
  }
  return {utility: token.slice(segmentStart), variants: segments}
}

function utilityRoot(utility: string): string | null {
  const dash = utility.indexOf('-')
  if (dash <= 0 || dash === utility.length - 1) return null
  return utility.slice(0, dash)
}

function utilityValue(utility: string): string | null {
  const dash = utility.indexOf('-')
  if (dash <= 0 || dash === utility.length - 1) return null
  return utility.slice(dash + 1)
}

function hasUtilityRoot(utility: string, root: string): boolean {
  return utility.startsWith(`${root}-`) && utility.length > root.length + 1
}
