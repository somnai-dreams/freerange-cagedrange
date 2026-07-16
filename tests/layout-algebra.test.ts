import {describe, expect, test} from 'bun:test'
import {
  layoutAdd,
  layoutBorderBlockSize,
  layoutBoxMetric,
  layoutChoice,
  layoutColumnBlockSize,
  layoutConstant,
  layoutMaximum,
  layoutMinimum,
  layoutOpaque,
  layoutRowBlockSize,
  layoutScale,
  layoutSymbol,
  layoutUnknown,
  proveLayoutEquality,
  type LayoutBox,
} from '../src/layout/index.ts'

const px = layoutConstant

describe('source-independent layout algebra', () => {
  test('proves a padding-built composer and catches the 54px control regression', () => {
    const restingContent = layoutRowBlockSize([px(30)])
    const restingComposer = layoutBorderBlockSize(restingContent, px(10), px(10), px(1), px(1))
    expect(proveLayoutEquality(restingComposer, px(52), 0.25)).toEqual({
      kind: 'proven',
      minimumDelta: 0,
      maximumDelta: 0,
    })

    const withControl = layoutBorderBlockSize(
      layoutRowBlockSize([px(30), px(32)]),
      px(10),
      px(10),
      px(1),
      px(1),
    )
    expect(proveLayoutEquality(withControl, px(52), 0.25)).toMatchObject({
      kind: 'violated',
      minimumDelta: 2,
      maximumDelta: 2,
    })

    const withOpaqueContent = layoutBorderBlockSize(
      layoutRowBlockSize([layoutUnknown('text height is opaque'), px(32)]),
      px(10),
      px(10),
      px(1),
      px(1),
    )
    expect(proveLayoutEquality(withOpaqueContent, px(52), 0.25)).toMatchObject({
      kind: 'violated',
      minimumDelta: 2,
      maximumDelta: null,
    })
  })

  test('composes row and column rules repeatedly', () => {
    const firstRow = layoutRowBlockSize([px(12), px(20)])
    const secondRow = layoutRowBlockSize([px(16), px(8)])
    const stack = layoutColumnBlockSize([firstRow, secondRow], px(4))
    const framed = layoutBorderBlockSize(stack, px(2), px(2), px(1), px(1))

    expect(proveLayoutEquality(framed, px(46))).toMatchObject({kind: 'proven'})
  })

  test('proves shared symbolic alignment and calculates a real offset', () => {
    const pageStart = layoutSymbol('page.blockStart')
    const controlsHeight = layoutSymbol('controls.blockSize')
    const feedStart = layoutAdd(pageStart, controlsHeight, px(24))
    const sidebarStart = layoutAdd(pageStart, controlsHeight, px(24))
    const offsetSidebarStart = layoutAdd(pageStart, controlsHeight, px(28))

    expect(proveLayoutEquality(feedStart, sidebarStart, 0.5)).toMatchObject({
      kind: 'proven',
      minimumDelta: 0,
      maximumDelta: 0,
    })
    expect(proveLayoutEquality(offsetSidebarStart, feedStart, 0.5)).toMatchObject({
      kind: 'violated',
      minimumDelta: 4,
      maximumDelta: 4,
    })
  })

  test('keeps unrelated intrinsic measurements unknown', () => {
    const pageStart = layoutSymbol('page.blockStart')
    const feedStart = layoutAdd(pageStart, layoutSymbol('feed.controls.blockSize'), px(24))
    const sidebarStart = layoutAdd(pageStart, layoutSymbol('sidebar.controls.blockSize'), px(24))

    expect(proveLayoutEquality(feedStart, sidebarStart, 0.5)).toMatchObject({
      kind: 'unknown',
      minimumDelta: null,
      maximumDelta: null,
    })
    expect(proveLayoutEquality(layoutAdd(pageStart, px(24)), layoutAdd(pageStart, px(24)), 0.5))
      .toMatchObject({kind: 'proven'})

    const narrowSymbol = layoutSymbol('shared-name', {minimum: 0, maximum: 10})
    const wideSymbol = layoutSymbol('shared-name', {minimum: 20, maximum: 30})
    expect(proveLayoutEquality(narrowSymbol, wideSymbol)).toMatchObject({kind: 'violated'})
  })

  test('a reachable violating alternative fails while two-sided alternatives stay uncorrelated', () => {
    expect(proveLayoutEquality(layoutChoice(px(52), px(54)), px(52), 0.25)).toMatchObject({
      kind: 'violated',
      minimumDelta: 2,
      maximumDelta: 2,
    })

    const left = layoutChoice(px(20), px(24))
    const right = layoutChoice(px(20), px(24))
    expect(proveLayoutEquality(left, left)).toMatchObject({kind: 'proven'})
    expect(proveLayoutEquality(layoutAdd(left, px(4)), layoutAdd(right, px(4)))).toMatchObject({kind: 'unknown'})
    const uncorrelated = proveLayoutEquality(left, layoutChoice(px(20), px(28)))
    expect(uncorrelated.kind).toBe('unknown')
    if (uncorrelated.kind === 'unknown') {
      expect(uncorrelated.reasons).toContain('alternatives on both sides cannot be correlated')
    }
  })

  test('derives logical starts, centers, ends, and sizes from one box', () => {
    const box: LayoutBox = {
      block: {start: px(100), size: px(52)},
      inline: {start: px(20), size: px(200)},
    }

    expect(proveLayoutEquality(
      layoutBoxMetric(box, {kind: 'edge', axis: 'block', edge: 'start'}),
      px(100),
    )).toMatchObject({kind: 'proven'})
    expect(proveLayoutEquality(
      layoutBoxMetric(box, {kind: 'edge', axis: 'block', edge: 'center'}),
      px(126),
    )).toMatchObject({kind: 'proven'})
    expect(proveLayoutEquality(
      layoutBoxMetric(box, {kind: 'edge', axis: 'inline', edge: 'end'}),
      px(220),
    )).toMatchObject({kind: 'proven'})
    expect(proveLayoutEquality(
      layoutBoxMetric(box, {kind: 'size', axis: 'inline'}),
      px(200),
    )).toMatchObject({kind: 'proven'})
  })

  test('unknown values do not become passes and bounded values provide a positive control', () => {
    const unknown = proveLayoutEquality(layoutUnknown('component intrinsic size is opaque'), px(52))
    expect(unknown.kind).toBe('unknown')
    if (unknown.kind === 'unknown') expect(unknown.reasons).toContain('component intrinsic size is opaque')

    const leftOpaqueMaximum = layoutMaximum(px(0), layoutUnknown('intrinsic size is opaque'))
    const rightOpaqueMaximum = layoutMaximum(px(0), layoutUnknown('intrinsic size is opaque'))
    expect(proveLayoutEquality(leftOpaqueMaximum, leftOpaqueMaximum)).toMatchObject({kind: 'proven'})
    expect(proveLayoutEquality(leftOpaqueMaximum, rightOpaqueMaximum)).toMatchObject({kind: 'unknown'})

    const boundedOpaque = layoutOpaque(
      {minimum: 54, maximum: null},
      'the remaining intrinsic content is opaque',
    )
    expect(proveLayoutEquality(boundedOpaque, px(52), 0.25)).toMatchObject({
      kind: 'violated',
      minimumDelta: 2,
      maximumDelta: null,
    })

    expect(proveLayoutEquality(layoutSymbol('component.blockSize', {minimum: 52, maximum: 52}), px(52)))
      .toMatchObject({kind: 'proven'})
  })

  test('independent alternatives never cancel, even wrapped in a selection', () => {
    const leftMax = layoutMaximum(px(0), layoutChoice(px(40), px(80)))
    const rightMax = layoutMaximum(px(0), layoutChoice(px(40), px(80)))
    const maxProof = proveLayoutEquality(leftMax, rightMax)
    expect(maxProof).toMatchObject({kind: 'unknown'})
    expect(maxProof.kind === 'unknown' ? maxProof.reasons : []).toContain(
      'alternatives on both sides cannot be correlated',
    )
    expect(proveLayoutEquality(
      layoutMinimum(layoutChoice(px(40), px(80)), px(100)),
      layoutMinimum(layoutChoice(px(40), px(80)), px(100)),
    )).toMatchObject({kind: 'unknown'})
  })

  test('the same alternative node cancels exactly while a copy stays independent', () => {
    const choice = layoutChoice(px(40), px(80))
    expect(proveLayoutEquality(layoutAdd(choice, px(8), layoutScale(-1, choice)), px(8)))
      .toMatchObject({kind: 'proven', minimumDelta: 0, maximumDelta: 0})
    const shared = layoutMaximum(px(0), choice)
    expect(proveLayoutEquality(layoutAdd(shared, px(4)), layoutAdd(shared, px(4))))
      .toMatchObject({kind: 'proven', minimumDelta: 0, maximumDelta: 0})
  })

  test('equal opaque descriptions never cancel; the same opaque node does', () => {
    const measured = layoutOpaque({minimum: 10, maximum: 20}, 'measured header')
    const lookalike = layoutOpaque({minimum: 10, maximum: 20}, 'measured header')
    expect(proveLayoutEquality(measured, lookalike)).toMatchObject({kind: 'unknown'})
    expect(proveLayoutEquality(layoutAdd(measured, px(4)), layoutAdd(measured, px(4))))
      .toMatchObject({kind: 'proven', minimumDelta: 0, maximumDelta: 0})
  })

  test('symbol names containing key delimiters never collide', () => {
    expect(proveLayoutEquality(
      layoutMaximum(layoutSymbol('a:null:null,symbol:b'), layoutSymbol('c')),
      layoutMaximum(layoutSymbol('a'), layoutSymbol('b:null:null,symbol:c')),
    )).toMatchObject({kind: 'unknown'})
  })

  test('a folded overflow degrades to an unknown value instead of throwing', () => {
    expect(proveLayoutEquality(px(-Number.MAX_VALUE), px(Number.MAX_VALUE), 0.25))
      .toMatchObject({kind: 'unknown'})
    expect(layoutAdd(px(1e308), px(1e308))).toMatchObject({kind: 'opaque'})
    expect(layoutScale(1e308, px(1e308))).toMatchObject({kind: 'opaque'})
  })

  test('rejects malformed public values at their construction boundary', () => {
    expect(() => layoutConstant(Number.NaN)).toThrow('layout constant must be finite')
    expect(() => layoutSymbol('', {minimum: 0, maximum: 1})).toThrow('layout symbol name must not be empty')
    expect(() => layoutSymbol('size', {minimum: 2, maximum: 1})).toThrow('minimum must not exceed')
    expect(() => layoutMaximum()).toThrow('layout maximum requires at least one expression')
    expect(() => proveLayoutEquality(px(1), px(1), -1)).toThrow('tolerance must not be negative')
    expect(proveLayoutEquality(
      layoutAdd(layoutSymbol('large-a', {minimum: 1e308, maximum: 1e308}),
        layoutSymbol('large-b', {minimum: 1e308, maximum: 1e308})),
      px(0),
    )).toMatchObject({kind: 'unknown'})
  })
})
