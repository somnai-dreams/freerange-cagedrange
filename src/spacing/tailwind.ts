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
  if (parsed == null) return null
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
  if (hasUtilityRoot(utility, 'gap-x')) return {axis: 'horizontal', kind: 'gap', value: utility.slice(6)}
  if (hasUtilityRoot(utility, 'gap-y')) return {axis: 'vertical', kind: 'gap', value: utility.slice(6)}
  if (hasUtilityRoot(utility, 'space-x')) {
    const value = utility.slice(8)
    return value === 'reverse' ? null : {axis: 'horizontal', kind: 'gap', value}
  }
  if (hasUtilityRoot(utility, 'space-y')) {
    const value = utility.slice(8)
    return value === 'reverse' ? null : {axis: 'vertical', kind: 'gap', value}
  }
  const root = utilityRoot(utility)
  if (root == null) return null
  const value = utilityValue(utility)
  if (value == null) return null
  switch (root) {
    case 'gap': return {axis: 'both', kind: 'gap', value}
    case 'p': return {axis: 'both', kind: 'padding', value}
    case 'pt':
    case 'pb':
    case 'py': return {axis: 'vertical', kind: 'padding', value}
    case 'pl':
    case 'pr':
    case 'px':
    case 'ps':
    case 'pe': return {axis: 'horizontal', kind: 'padding', value}
    default: {
      const marginAxis = marginUtilityAxis(utility)
      if (marginAxis == null) return null
      return {axis: marginAxis, kind: 'margin', value}
    }
  }
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
  if (hasUtilityRoot(utility, 'inset-y')) return ['top', 'bottom']
  if (hasUtilityRoot(utility, 'inset-x')) return ['left', 'right']
  if (hasUtilityRoot(utility, 'inset-s')) return ['inlineStart']
  if (hasUtilityRoot(utility, 'inset-e')) return ['inlineEnd']
  if (hasUtilityRoot(utility, 'inset-bs')) return ['blockStart']
  if (hasUtilityRoot(utility, 'inset-be')) return ['blockEnd']
  if (hasUtilityRoot(utility, 'inset')) return ['top', 'bottom', 'left', 'right']
  const root = utilityRoot(utility)
  if (root == null) return null
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
