import {proveLayoutEquality, type LayoutEqualityProof, type LayoutExpression, type LayoutMetric} from './algebra.ts'

export type LayoutBoxLayer = 'border' | 'padding' | 'content'

export type LayoutMeasurementConstraint<Reference, Scenario extends string = string> =
  | {
      kind: 'equalsPixels'
      name: string
      target: Reference
      metric: Extract<LayoutMetric, {kind: 'size'}>
      box: LayoutBoxLayer
      pixels: number
      tolerancePx: number
      scenarios: [Scenario, ...Scenario[]]
    }
  | {
      kind: 'align'
      name: string
      members: [Reference, Reference, ...Reference[]]
      metric: Extract<LayoutMetric, {kind: 'edge'}>
      box: LayoutBoxLayer
      tolerancePx: number
      scenarios: [Scenario, ...Scenario[]]
    }

export type LayoutAlignmentComparison = {
  leftIndex: number
  rightIndex: number
  proof: LayoutEqualityProof
}

export type LayoutAlignmentProof = {
  kind: 'proven' | 'violated' | 'unknown'
  comparisons: LayoutAlignmentComparison[]
}

export function proveLayoutAlignment(
  expressions: [LayoutExpression, LayoutExpression, ...LayoutExpression[]],
  tolerance = 0,
): LayoutAlignmentProof {
  if (expressions.length < 2) throw new Error('layout alignment requires at least two expressions')
  const comparisons: LayoutAlignmentComparison[] = []
  for (let leftIndex = 0; leftIndex < expressions.length; leftIndex++) {
    for (let rightIndex = leftIndex + 1; rightIndex < expressions.length; rightIndex++) {
      comparisons.push({
        leftIndex,
        rightIndex,
        proof: proveLayoutEquality(expressions[leftIndex]!, expressions[rightIndex]!, tolerance),
      })
    }
  }
  if (comparisons.some(comparison => comparison.proof.kind === 'violated')) {
    return {kind: 'violated', comparisons}
  }
  if (comparisons.some(comparison => comparison.proof.kind === 'unknown')) {
    return {kind: 'unknown', comparisons}
  }
  return {kind: 'proven', comparisons}
}
