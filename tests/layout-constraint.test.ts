import {describe, expect, test} from 'bun:test'
import {
  layoutAdd,
  layoutChoice,
  layoutConstant,
  layoutMaximum,
  layoutSymbol,
  proveLayoutAlignment,
  type LayoutMeasurementConstraint,
} from '../src/layout/index.ts'

type Reference = {kind: 'target'; name: string}

describe('shared layout constraints', () => {
  test('keeps references outside the proof core while sharing metric and box vocabulary', () => {
    const constraint: LayoutMeasurementConstraint<Reference, 'desktop'> = {
      kind: 'align',
      name: 'content starts align',
      members: [
        {kind: 'target', name: 'feed'},
        {kind: 'target', name: 'sidebar'},
      ],
      metric: {kind: 'edge', axis: 'block', edge: 'start'},
      box: 'border',
      tolerancePx: 0.5,
      scenarios: ['desktop'],
    }

    expect(constraint.members).toHaveLength(2)
  })

  test('checks every pair rather than comparing each member only with the first', () => {
    const proof = proveLayoutAlignment([
      layoutConstant(0),
      layoutConstant(0.75),
      layoutConstant(-0.75),
    ], 1)

    expect(proof.kind).toBe('violated')
    expect(proof.comparisons).toHaveLength(3)
    expect(proof.comparisons[2]?.proof).toMatchObject({
      kind: 'violated',
      minimumDelta: 1.5,
      maximumDelta: 1.5,
    })
  })

  test('proves shared symbolic starts and keeps unrelated measurements unknown', () => {
    const pageStart = layoutSymbol('page.blockStart')
    const headerSize = layoutSymbol('header.blockSize')
    const sharedStart = layoutAdd(pageStart, headerSize, layoutConstant(24))
    expect(proveLayoutAlignment([sharedStart, sharedStart, sharedStart], 0.5).kind).toBe('proven')

    const unrelatedStart = layoutAdd(pageStart, layoutSymbol('sidebar.header.blockSize'), layoutConstant(24))
    expect(proveLayoutAlignment([sharedStart, unrelatedStart], 0.5).kind).toBe('unknown')
  })

  test('rejects an invalid runtime member count at the public boundary', () => {
    expect(() => proveLayoutAlignment([] as never, 0.5)).toThrow(
      'layout alignment requires at least two expressions',
    )
  })

  test('independently conditional members never align by structural similarity', () => {
    const sibling = () => layoutMaximum(
      layoutConstant(0),
      layoutChoice(layoutConstant(40), layoutConstant(80)),
    )
    expect(proveLayoutAlignment([sibling(), sibling()], 0).kind).toBe('unknown')
  })
})
