import {describe, expect, test} from 'bun:test'
import {parseLayoutSuite} from '../src/layout/config.ts'

const suite = {
  baseUrl: 'http://127.0.0.1:3000/app/',
  targets: [
    {name: 'composer', selector: '[data-fr-layout="composer"]'},
    {name: 'feed-content', selector: '[data-fr-layout="feed-content"]'},
    {name: 'sidebar-content', selector: '[data-fr-layout="sidebar-content"]'},
  ],
  scenarios: [
    {name: 'resting', url: 'resting', viewport: {width: 1440, height: 900}, readySelector: 'body'},
  ],
  constraints: [
    {
      kind: 'equalsPixels',
      name: 'resting composer height',
      target: 'composer',
      metric: {kind: 'size', axis: 'block'},
      pixels: 52,
      tolerancePx: 0.25,
      scenarios: ['resting'],
    },
    {
      kind: 'align',
      name: 'content starts align',
      targets: ['feed-content', 'sidebar-content'],
      metric: {kind: 'edge', axis: 'block', edge: 'start'},
      tolerancePx: 0.5,
      scenarios: ['resting'],
    },
  ],
  inferAlignments: [{
    name: 'gallery columns',
    tracks: ['feed-content', 'sidebar-content'],
    axis: 'block',
    tolerancePx: 0.5,
    scenarios: ['resting'],
  }],
}

describe('layout suite parsing', () => {
  test('normalizes scenario URLs and validates the complete suite at the boundary', () => {
    const parsed = parseLayoutSuite(suite)
    expect(parsed.scenarios[0]?.url).toBe('http://127.0.0.1:3000/app/resting')
    expect(parsed.constraints.map(constraint => constraint.kind)).toEqual(['equalsPixels', 'align'])
    expect(parsed.inferAlignments.map(inference => inference.name)).toEqual(['gallery columns'])
  })

  test('source targets share one stable marker with the rendered selector', () => {
    const parsed = parseLayoutSuite({
      ...suite,
      targets: [{
        ...suite.targets[0],
        selector: '[data-fr-layout="composer"]',
        source: {kind: 'jsx', file: 'src/Composer.tsx', marker: 'composer'},
      }, ...suite.targets.slice(1)],
    })
    expect(parsed.targets[0]?.source).toEqual({
      kind: 'jsx',
      file: 'src/Composer.tsx',
      marker: 'composer',
    })
    expect(() => parseLayoutSuite({
      ...suite,
      targets: [{
        ...suite.targets[0],
        selector: '[data-fr-layout="different"]',
        source: {kind: 'jsx', file: 'src/Composer.tsx', marker: 'composer'},
      }, ...suite.targets.slice(1)],
    })).toThrow("selector must be '[data-fr-layout=\"composer\"]'")
  })

  test('rejects unknown fields, malformed metrics, and invalid numbers', () => {
    expect(() => parseLayoutSuite({...suite, surprise: true})).toThrow("unknown field 'surprise'")
    expect(() => parseLayoutSuite({
      ...suite,
      constraints: [{...suite.constraints[0], metric: {kind: 'edge', axis: 'block', edge: 'start'}}],
    })).toThrow('must be a size metric')
    expect(() => parseLayoutSuite({
      ...suite,
      constraints: [{...suite.constraints[0], tolerancePx: -1}],
    })).toThrow('must be nonnegative')
    expect(() => parseLayoutSuite({
      ...suite,
      constraints: [{...suite.constraints[0], pixels: -1}],
    })).toThrow('must be nonnegative')
    expect(() => parseLayoutSuite({
      ...suite,
      scenarios: [{...suite.scenarios[0], viewport: {width: 0, height: 900}}],
    })).toThrow('must be a positive integer')
    expect(() => parseLayoutSuite({
      ...suite,
      scenarios: [{name: 'resting', url: 'resting', viewport: {width: 1440, height: 900}}],
    })).toThrow('readySelector must be a non-empty string')
  })

  test('rejects missing and duplicate references before browser work starts', () => {
    expect(() => parseLayoutSuite({
      ...suite,
      targets: [...suite.targets, suite.targets[0]],
    })).toThrow("Duplicate layout target name 'composer'")
    expect(() => parseLayoutSuite({
      ...suite,
      constraints: [{...suite.constraints[0], target: 'missing'}],
    })).toThrow("references unknown target 'missing'")
    expect(() => parseLayoutSuite({
      ...suite,
      constraints: [{...suite.constraints[0], scenarios: ['missing']}],
    })).toThrow("references unknown scenario 'missing'")
  })

  test('alignment groups require distinct targets', () => {
    expect(() => parseLayoutSuite({
      ...suite,
      constraints: [{...suite.constraints[1], targets: ['feed-content']}],
    })).toThrow('must contain at least two targets')
    expect(() => parseLayoutSuite({
      ...suite,
      constraints: [{...suite.constraints[1], targets: ['feed-content', 'feed-content']}],
    })).toThrow('must not repeat a target')
    expect(() => parseLayoutSuite({
      ...suite,
      inferAlignments: [{...suite.inferAlignments[0], tracks: ['feed-content']}],
    })).toThrow('must contain at least two targets')
    expect(() => parseLayoutSuite({
      ...suite,
      inferAlignments: [{...suite.inferAlignments[0], tracks: ['feed-content', 'feed-content']}],
    })).toThrow('must not repeat a target')
  })
})
