import {describe, expect, test} from 'bun:test'
import {parseStaticLayoutSuite} from '../src/layout/config.ts'
import type {StaticLayoutSuite} from '../src/layout/model.ts'

const suite: StaticLayoutSuite = {
  targets: [{
    name: 'composer',
    source: {kind: 'jsx', file: 'src/Composer.tsx', marker: 'composer'},
  }],
  constraints: [{
    kind: 'intrinsicBlockSize',
    name: 'composer intrinsic height',
    target: 'composer',
    pixels: 52,
    tolerancePx: 0.25,
    viewportWidths: [390, 1440],
  }],
}

describe('static layout suite parsing', () => {
  test('validates and normalizes the complete suite at the boundary', () => {
    const parsed = parseStaticLayoutSuite(suite)
    expect(parsed).toEqual(suite)
  })

  test('rejects unknown fields, malformed source markers, and invalid numbers', () => {
    expect(() => parseStaticLayoutSuite({...suite, surprise: true})).toThrow("unknown field 'surprise'")
    expect(() => parseStaticLayoutSuite({
      ...suite,
      targets: [{...suite.targets[0], source: {...suite.targets[0]!.source, marker: 'not valid'}}],
    })).toThrow('may contain only letters')
    expect(() => parseStaticLayoutSuite({
      ...suite,
      constraints: [{...suite.constraints[0], tolerancePx: -1}],
    })).toThrow('must be a nonnegative finite number')
    expect(() => parseStaticLayoutSuite({
      ...suite,
      constraints: [{...suite.constraints[0], pixels: -1}],
    })).toThrow('must be a nonnegative finite number')
    expect(() => parseStaticLayoutSuite({
      ...suite,
      constraints: [{...suite.constraints[0], viewportWidths: []}],
    })).toThrow('must not be empty')
    expect(() => parseStaticLayoutSuite({
      ...suite,
      constraints: [{...suite.constraints[0], viewportWidths: [0]}],
    })).toThrow('must be a positive integer')
  })

  test('rejects duplicate names and missing references before analysis starts', () => {
    expect(() => parseStaticLayoutSuite({
      ...suite,
      targets: [...suite.targets, suite.targets[0]],
    })).toThrow("Duplicate layout target name 'composer'")
    expect(() => parseStaticLayoutSuite({
      ...suite,
      constraints: [{...suite.constraints[0], target: 'missing'}],
    })).toThrow("references unknown target 'missing'")
    expect(() => parseStaticLayoutSuite({
      ...suite,
      constraints: [...suite.constraints, suite.constraints[0]],
    })).toThrow("Duplicate layout constraint name 'composer intrinsic height'")
  })
})
