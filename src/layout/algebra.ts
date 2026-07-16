export type LayoutAxis = 'block' | 'inline'

export type LayoutMetric =
  | {kind: 'edge'; axis: LayoutAxis; edge: 'start' | 'center' | 'end'}
  | {kind: 'size'; axis: LayoutAxis}

export type LayoutExpression =
  | {kind: 'constant'; value: number}
  | {kind: 'symbol'; name: string; minimum: number | null; maximum: number | null}
  | {kind: 'sum'; values: [LayoutExpression, ...LayoutExpression[]]}
  | {kind: 'scale'; factor: number; value: LayoutExpression}
  | {kind: 'minimum'; values: [LayoutExpression, ...LayoutExpression[]]}
  | {kind: 'maximum'; values: [LayoutExpression, ...LayoutExpression[]]}
  | {kind: 'choice'; values: [LayoutExpression, ...LayoutExpression[]]}
  | {
      kind: 'opaque'
      minimum: number | null
      maximum: number | null
      reasons: [string, ...string[]]
    }

export type LayoutExpressionRange = {
  minimum: number | null
  maximum: number | null
}

export type LayoutBoxAxis = {
  start: LayoutExpression
  size: LayoutExpression
}

export type LayoutBox = {
  block: LayoutBoxAxis
  inline: LayoutBoxAxis
}

export type LayoutEqualityProof =
  | {
      kind: 'proven'
      minimumDelta: number | null
      maximumDelta: number | null
    }
  | {
      kind: 'violated'
      minimumDelta: number | null
      maximumDelta: number | null
      left: LayoutExpression
      right: LayoutExpression
    }
  | {
      kind: 'unknown'
      minimumDelta: number | null
      maximumDelta: number | null
      reasons: [string, ...string[]]
    }

type AffineAtom = {
  key: string
  expression: LayoutExpression
  coefficient: number
}

type AffineExpression = {
  constant: number
  atoms: AffineAtom[]
  reasons: string[]
}

const maximumProofAlternatives = 64

export function layoutConstant(value: number): LayoutExpression {
  finiteNumber(value, 'layout constant')
  return {kind: 'constant', value}
}

export function layoutSymbol(
  name: string,
  range: LayoutExpressionRange = {minimum: null, maximum: null},
): LayoutExpression {
  if (name.trim() === '') throw new Error('layout symbol name must not be empty')
  validRange(range, `layout symbol '${name}'`)
  return {kind: 'symbol', name, minimum: range.minimum, maximum: range.maximum}
}

export function layoutUnknown(reason: string | [string, ...string[]]): LayoutExpression {
  return layoutOpaque({minimum: null, maximum: null}, reason)
}

export function layoutOpaque(
  range: LayoutExpressionRange,
  reason: string | [string, ...string[]],
): LayoutExpression {
  validRange(range, 'opaque layout expression')
  const reasons = uniqueStrings(typeof reason === 'string' ? [reason] : reason)
  if (reasons.length === 0 || reasons.some(item => item.trim() === '')) {
    throw new Error('opaque layout expression reasons must be non-empty strings')
  }
  return {
    kind: 'opaque',
    minimum: range.minimum,
    maximum: range.maximum,
    reasons: reasons as [string, ...string[]],
  }
}

export function layoutAdd(...expressions: LayoutExpression[]): LayoutExpression {
  const values: LayoutExpression[] = []
  let constant = 0
  for (const expression of expressions) {
    const terms = expression.kind === 'sum' ? expression.values : [expression]
    for (const term of terms) {
      if (term.kind === 'constant') constant += term.value
      else values.push(term)
    }
  }
  finiteNumber(constant, 'layout sum')
  values.sort((left, right) => expressionKey(left).localeCompare(expressionKey(right)))
  if (constant !== 0 || values.length === 0) values.push(layoutConstant(constant))
  if (values.length === 1) return values[0]!
  return {kind: 'sum', values: values as [LayoutExpression, ...LayoutExpression[]]}
}

export function layoutScale(factor: number, expression: LayoutExpression): LayoutExpression {
  finiteNumber(factor, 'layout scale')
  if (factor === 0) return layoutConstant(0)
  if (factor === 1) return expression
  if (expression.kind === 'constant') return layoutConstant(factor * expression.value)
  if (expression.kind === 'scale') return layoutScale(factor * expression.factor, expression.value)
  return {kind: 'scale', factor, value: expression}
}

export function layoutMinimum(...expressions: LayoutExpression[]): LayoutExpression {
  return selection('minimum', expressions)
}

export function layoutMaximum(...expressions: LayoutExpression[]): LayoutExpression {
  return selection('maximum', expressions)
}

export function layoutChoice(...expressions: LayoutExpression[]): LayoutExpression {
  if (expressions.length === 0) throw new Error('layout choice requires at least one expression')
  const flattened = expressions.flatMap(expression => expression.kind === 'choice' ? expression.values : [expression])
  const values = uniqueExpressions(flattened)
  if (values.length === 1) return values[0]!
  return {kind: 'choice', values: values as [LayoutExpression, ...LayoutExpression[]]}
}

export function layoutRowBlockSize(children: LayoutExpression[]): LayoutExpression {
  return children.length === 0 ? layoutConstant(0) : layoutMaximum(...children)
}

export function layoutColumnBlockSize(
  children: LayoutExpression[],
  gap: LayoutExpression = layoutConstant(0),
): LayoutExpression {
  if (children.length === 0) return layoutConstant(0)
  return layoutAdd(...children, layoutScale(children.length - 1, gap))
}

export function layoutBorderBlockSize(
  content: LayoutExpression,
  paddingStart: LayoutExpression,
  paddingEnd: LayoutExpression,
  borderStart: LayoutExpression,
  borderEnd: LayoutExpression,
): LayoutExpression {
  return layoutAdd(content, paddingStart, paddingEnd, borderStart, borderEnd)
}

export function layoutBoxMetric(box: LayoutBox, metric: LayoutMetric): LayoutExpression {
  const axis = metric.axis === 'block' ? box.block : box.inline
  switch (metric.kind) {
    case 'size': return axis.size
    case 'edge': {
      switch (metric.edge) {
        case 'start': return axis.start
        case 'center': return layoutAdd(axis.start, layoutScale(0.5, axis.size))
        case 'end': return layoutAdd(axis.start, axis.size)
      }
    }
  }
}

export function layoutExpressionRange(expression: LayoutExpression): LayoutExpressionRange {
  switch (expression.kind) {
    case 'constant': return {minimum: expression.value, maximum: expression.value}
    case 'symbol': return {minimum: expression.minimum, maximum: expression.maximum}
    case 'opaque': return {minimum: expression.minimum, maximum: expression.maximum}
    case 'sum': return expression.values.reduce<LayoutExpressionRange>((range, value) =>
      addRanges(range, layoutExpressionRange(value)), {minimum: 0, maximum: 0})
    case 'scale': return scaleRange(expression.factor, layoutExpressionRange(expression.value))
    case 'choice': return unionRanges(expression.values.map(layoutExpressionRange))
    case 'maximum': {
      const ranges = expression.values.map(layoutExpressionRange)
      return {
        minimum: anyNumber(ranges.map(range => range.minimum), Math.max),
        maximum: allNumbers(ranges.map(range => range.maximum), Math.max),
      }
    }
    case 'minimum': {
      const ranges = expression.values.map(layoutExpressionRange)
      return {
        minimum: allNumbers(ranges.map(range => range.minimum), Math.min),
        maximum: anyNumber(ranges.map(range => range.maximum), Math.min),
      }
    }
  }
}

export function proveLayoutEquality(
  left: LayoutExpression,
  right: LayoutExpression,
  tolerance = 0,
): LayoutEqualityProof {
  nonnegativeFiniteNumber(tolerance, 'layout equality tolerance')
  if (left === right) return {kind: 'proven', minimumDelta: 0, maximumDelta: 0}
  const direct = proveSingleEquality(left, right, tolerance)
  if (direct.kind !== 'unknown') return direct

  const leftHasChoice = containsChoice(left)
  const rightHasChoice = containsChoice(right)
  if (!leftHasChoice && !rightHasChoice) return direct
  if (leftHasChoice && rightHasChoice) {
    return {
      ...direct,
      reasons: uniqueStrings([
        ...direct.reasons,
        'alternatives on both sides cannot be correlated',
      ]) as [string, ...string[]],
    }
  }

  const expanded = expandChoices(leftHasChoice ? left : right, maximumProofAlternatives)
  if (expanded == null) {
    return {
      ...direct,
      reasons: uniqueStrings([
        ...direct.reasons,
        `layout alternatives exceed the proof limit of ${maximumProofAlternatives}`,
      ]) as [string, ...string[]],
    }
  }
  const proofs = expanded.map(expression => leftHasChoice
    ? proveSingleEquality(expression, right, tolerance)
    : proveSingleEquality(left, expression, tolerance))
  const violation = proofs.find(proof => proof.kind === 'violated')
  if (violation != null) return violation
  const range = unionProofRanges(proofs)
  if (proofs.every(proof => proof.kind === 'proven')) return {kind: 'proven', ...range}
  return {
    kind: 'unknown',
    ...range,
    reasons: uniqueStrings(proofs.flatMap(proof => proof.kind === 'unknown' ? proof.reasons : [])) as [string, ...string[]],
  }
}

function selection(
  kind: 'minimum' | 'maximum',
  expressions: LayoutExpression[],
): LayoutExpression {
  if (expressions.length === 0) throw new Error(`layout ${kind} requires at least one expression`)
  const flattened = expressions.flatMap(expression => expression.kind === kind ? expression.values : [expression])
  if (flattened.every(expression => expression.kind === 'constant')) {
    const values = flattened.map(expression => (expression as {kind: 'constant'; value: number}).value)
    return layoutConstant(kind === 'minimum' ? Math.min(...values) : Math.max(...values))
  }
  const values = uniqueExpressions(flattened)
  if (values.length === 1) return values[0]!
  return {kind, values: values as [LayoutExpression, ...LayoutExpression[]]}
}

function proveSingleEquality(
  left: LayoutExpression,
  right: LayoutExpression,
  tolerance: number,
): LayoutEqualityProof {
  const affine = affineExpression(layoutAdd(left, layoutScale(-1, right)))
  const affineBounds = affineRange(affine)
  const independentBounds = subtractRanges(layoutExpressionRange(left), layoutExpressionRange(right))
  const range = intersectRanges(affineBounds, independentBounds)
  if (range.minimum != null && range.maximum != null
    && range.minimum >= -tolerance && range.maximum <= tolerance) {
    return {kind: 'proven', minimumDelta: range.minimum, maximumDelta: range.maximum}
  }
  if ((range.minimum != null && range.minimum > tolerance)
    || (range.maximum != null && range.maximum < -tolerance)) {
    return {
      kind: 'violated',
      minimumDelta: range.minimum,
      maximumDelta: range.maximum,
      left,
      right,
    }
  }
  const reasons = uniqueStrings([
    ...affine.reasons,
    ...collectUnknownReasons(left),
    ...collectUnknownReasons(right),
    'layout difference is not bounded within the tolerance',
  ])
  return {
    kind: 'unknown',
    minimumDelta: range.minimum,
    maximumDelta: range.maximum,
    reasons: reasons as [string, ...string[]],
  }
}

function affineExpression(expression: LayoutExpression): AffineExpression {
  switch (expression.kind) {
    case 'constant': return {constant: expression.value, atoms: [], reasons: []}
    case 'sum': return expression.values.reduce<AffineExpression>((affine, value) =>
      addAffine(affine, affineExpression(value)), {constant: 0, atoms: [], reasons: []})
    case 'scale': return scaleAffine(expression.factor, affineExpression(expression.value))
    case 'opaque': return {constant: 0, atoms: [], reasons: expression.reasons}
    case 'choice': return {constant: 0, atoms: [], reasons: ['layout alternatives require correlation']}
    default: {
      const reasons = collectUnknownReasons(expression)
      return reasons.length > 0
        ? {constant: 0, atoms: [], reasons}
        : {
            constant: 0,
            atoms: [{key: expressionKey(expression), expression, coefficient: 1}],
            reasons: [],
          }
    }
  }
}

function addAffine(left: AffineExpression, right: AffineExpression): AffineExpression {
  const atoms = left.atoms.map(atom => ({...atom}))
  for (const rightAtom of right.atoms) {
    const existing = atoms.find(atom => atom.key === rightAtom.key)
    if (existing == null) atoms.push({...rightAtom})
    else existing.coefficient += rightAtom.coefficient
  }
  return {
    constant: left.constant + right.constant,
    atoms: atoms.filter(atom => atom.coefficient !== 0).sort((a, b) => a.key.localeCompare(b.key)),
    reasons: uniqueStrings([...left.reasons, ...right.reasons]),
  }
}

function scaleAffine(factor: number, affine: AffineExpression): AffineExpression {
  return {
    constant: affine.constant * factor,
    atoms: affine.atoms.map(atom => ({...atom, coefficient: atom.coefficient * factor})),
    reasons: affine.reasons,
  }
}

function affineRange(affine: AffineExpression): LayoutExpressionRange {
  if (!Number.isFinite(affine.constant)
    || affine.atoms.some(atom => !Number.isFinite(atom.coefficient))) {
    return {minimum: null, maximum: null}
  }
  let range: LayoutExpressionRange = {minimum: affine.constant, maximum: affine.constant}
  for (const atom of affine.atoms) {
    range = addRanges(range, scaleRange(atom.coefficient, layoutExpressionRange(atom.expression)))
  }
  if (affine.reasons.length > 0) return {minimum: null, maximum: null}
  return range
}

function expandChoices(expression: LayoutExpression, limit: number): LayoutExpression[] | null {
  switch (expression.kind) {
    case 'choice': {
      const values: LayoutExpression[] = []
      for (const value of expression.values) {
        const expanded = expandChoices(value, limit)
        if (expanded == null || values.length + expanded.length > limit) return null
        values.push(...expanded)
      }
      return values
    }
    case 'sum': return expandCombination(expression.values, limit, values => layoutAdd(...values))
    case 'scale': {
      const values = expandChoices(expression.value, limit)
      return values?.map(value => layoutScale(expression.factor, value)) ?? null
    }
    case 'minimum': return expandCombination(expression.values, limit, values => layoutMinimum(...values))
    case 'maximum': return expandCombination(expression.values, limit, values => layoutMaximum(...values))
    default: return [expression]
  }
}

function expandCombination(
  expressions: LayoutExpression[],
  limit: number,
  combine: (values: LayoutExpression[]) => LayoutExpression,
): LayoutExpression[] | null {
  let combinations: LayoutExpression[][] = [[]]
  for (const expression of expressions) {
    const values = expandChoices(expression, limit)
    if (values == null || combinations.length * values.length > limit) return null
    const next: LayoutExpression[][] = []
    for (const combination of combinations) {
      for (const value of values) next.push([...combination, value])
    }
    combinations = next
  }
  return combinations.map(combine)
}

function containsChoice(expression: LayoutExpression): boolean {
  switch (expression.kind) {
    case 'choice': return true
    case 'sum':
    case 'minimum':
    case 'maximum': return expression.values.some(containsChoice)
    case 'scale': return containsChoice(expression.value)
    default: return false
  }
}

function collectUnknownReasons(expression: LayoutExpression): string[] {
  switch (expression.kind) {
    case 'opaque': return expression.reasons
    case 'sum':
    case 'minimum':
    case 'maximum':
    case 'choice': return expression.values.flatMap(collectUnknownReasons)
    case 'scale': return collectUnknownReasons(expression.value)
    default: return []
  }
}

function expressionKey(expression: LayoutExpression): string {
  switch (expression.kind) {
    case 'constant': return `constant:${expression.value}`
    case 'symbol': return `symbol:${expression.name}:${expression.minimum}:${expression.maximum}`
    case 'opaque': return `opaque:${expression.minimum}:${expression.maximum}:${expression.reasons.join('|')}`
    case 'scale': return `scale:${expression.factor}:${expressionKey(expression.value)}`
    case 'sum':
    case 'minimum':
    case 'maximum':
    case 'choice': return `${expression.kind}:${expression.values.map(expressionKey).join(',')}`
  }
}

function uniqueExpressions(expressions: LayoutExpression[]): LayoutExpression[] {
  const values: LayoutExpression[] = []
  for (const expression of expressions) {
    const key = expressionKey(expression)
    if (!values.some(value => expressionKey(value) === key)) values.push(expression)
  }
  values.sort((left, right) => expressionKey(left).localeCompare(expressionKey(right)))
  return values
}

function addRanges(left: LayoutExpressionRange, right: LayoutExpressionRange): LayoutExpressionRange {
  return {
    minimum: left.minimum == null || right.minimum == null
      ? null
      : finiteResult(left.minimum + right.minimum),
    maximum: left.maximum == null || right.maximum == null
      ? null
      : finiteResult(left.maximum + right.maximum),
  }
}

function subtractRanges(left: LayoutExpressionRange, right: LayoutExpressionRange): LayoutExpressionRange {
  return addRanges(left, scaleRange(-1, right))
}

function intersectRanges(left: LayoutExpressionRange, right: LayoutExpressionRange): LayoutExpressionRange {
  return {
    minimum: anyNumber([left.minimum, right.minimum], Math.max),
    maximum: anyNumber([left.maximum, right.maximum], Math.min),
  }
}

function scaleRange(factor: number, range: LayoutExpressionRange): LayoutExpressionRange {
  if (factor >= 0) {
    return {
      minimum: range.minimum == null ? null : finiteResult(range.minimum * factor),
      maximum: range.maximum == null ? null : finiteResult(range.maximum * factor),
    }
  }
  return {
    minimum: range.maximum == null ? null : finiteResult(range.maximum * factor),
    maximum: range.minimum == null ? null : finiteResult(range.minimum * factor),
  }
}

function finiteResult(value: number): number | null {
  return Number.isFinite(value) ? value : null
}

function unionRanges(ranges: LayoutExpressionRange[]): LayoutExpressionRange {
  return {
    minimum: allNumbers(ranges.map(range => range.minimum), Math.min),
    maximum: allNumbers(ranges.map(range => range.maximum), Math.max),
  }
}

function unionProofRanges(proofs: LayoutEqualityProof[]): {
  minimumDelta: number | null
  maximumDelta: number | null
} {
  const range = unionRanges(proofs.map(proof => ({minimum: proof.minimumDelta, maximum: proof.maximumDelta})))
  return {minimumDelta: range.minimum, maximumDelta: range.maximum}
}

function allNumbers(
  values: Array<number | null>,
  combine: (...values: number[]) => number,
): number | null {
  const present = values.filter(value => value != null)
  return present.length === values.length ? combine(...present) : null
}

function anyNumber(
  values: Array<number | null>,
  combine: (...values: number[]) => number,
): number | null {
  const present = values.filter(value => value != null)
  return present.length === 0 ? null : combine(...present)
}

function validRange(range: LayoutExpressionRange, label: string): void {
  if (range.minimum != null) finiteNumber(range.minimum, `${label} minimum`)
  if (range.maximum != null) finiteNumber(range.maximum, `${label} maximum`)
  if (range.minimum != null && range.maximum != null && range.minimum > range.maximum) {
    throw new Error(`${label} minimum must not exceed its maximum`)
  }
}

function finiteNumber(value: number, label: string): void {
  if (!Number.isFinite(value)) throw new Error(`${label} must be finite`)
}

function nonnegativeFiniteNumber(value: number, label: string): void {
  finiteNumber(value, label)
  if (value < 0) throw new Error(`${label} must not be negative`)
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)]
}
