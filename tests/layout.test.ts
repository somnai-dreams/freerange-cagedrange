import {describe, expect, test} from 'bun:test'
import {auditLayoutSnapshots} from '../src/layout/audit.ts'
import {formatLayoutReport} from '../src/layout/report.ts'
import type {
  LayoutBox,
  LayoutConstraint,
  LayoutScenarioSnapshot,
  LayoutSuite,
  LayoutTargetObservation,
} from '../src/layout/model.ts'

const constraints: LayoutConstraint[] = [
  {
    kind: 'equalsPixels',
    name: 'resting composer height',
    target: 'composer',
    metric: {kind: 'size', axis: 'block'},
    pixels: 52,
    tolerancePx: 0.25,
    scenarios: ['resting', 'with-button'],
  },
  {
    kind: 'align',
    name: 'content starts align',
    targets: ['feed-content', 'sidebar-content'],
    metric: {kind: 'edge', axis: 'block', edge: 'start'},
    tolerancePx: 0.5,
    scenarios: ['resting', 'with-button'],
  },
]

const suite: LayoutSuite = {
  targets: [
    {name: 'composer', selector: '#composer'},
    {name: 'feed-content', selector: '#feed-content'},
    {name: 'sidebar-content', selector: '#sidebar-content'},
  ],
  scenarios: [
    {
      name: 'resting',
      url: 'http://example.test/resting',
      viewport: {width: 1440, height: 900},
      readySelector: 'body',
    },
    {
      name: 'with-button',
      url: 'http://example.test/with-button',
      viewport: {width: 1440, height: 900},
      readySelector: 'body',
    },
  ],
  constraints,
}

describe('rendered layout contracts', () => {
  test('checks the same exact-size contract in every named conditional scenario', () => {
    const audit = auditLayoutSnapshots(suite, [
      snapshot('resting', [
        observation('composer', box(0, 52, [child('send button', 40)])),
        observation('feed-content', box(286, 100)),
        observation('sidebar-content', box(286, 100)),
      ]),
      snapshot('with-button', [
        observation('composer', box(0, 54, [
          child('send button', 40),
          child('search button', 52),
          child('popover', 500, 40, 'absolute'),
        ])),
        observation('feed-content', box(286, 100)),
        observation('sidebar-content', box(286, 100)),
      ]),
    ])

    expect(audit.scenarios[0]?.checks.map(check => check.kind)).toEqual(['pass', 'pass'])
    expect(audit.scenarios[1]?.checks.map(check => check.kind)).toEqual(['fail', 'pass'])
    expect(audit.scenarios[1]?.checks[0]).toMatchObject({
      kind: 'fail',
      rule: 'layout-size',
      measurements: [54],
      expected: 52,
      deltaPx: 2,
      contributors: [{label: 'search button', outerSize: 52}],
    })
  })

  test('checks multiple relationships in one render without a passing row hiding a failing row', () => {
    const controls: LayoutConstraint = {
      kind: 'align',
      name: 'control rows align',
      targets: ['feed-controls', 'sidebar-controls'],
      metric: {kind: 'edge', axis: 'block', edge: 'start'},
      tolerancePx: 0.5,
      scenarios: ['resting'],
    }
    const audit = auditLayoutSnapshots(
      {...suite, constraints: [controls, constraints[1]!], scenarios: [suite.scenarios[0]!]},
      [snapshot('resting', [
        observation('feed-controls', box(230, 40)),
        observation('sidebar-controls', box(230, 40)),
        observation('feed-content', box(286, 100)),
        observation('sidebar-content', box(316, 100)),
      ])],
    )

    expect(audit.scenarios[0]?.checks).toEqual([
      {kind: 'pass', scenario: 'resting', constraint: 'control rows align', measurements: [230, 230]},
      {
        kind: 'fail',
        scenario: 'resting',
        constraint: 'content starts align',
        rule: 'layout-alignment',
        measurements: [286, 316],
        expected: 'aligned',
        tolerancePx: 0.5,
        deltaPx: 30,
        contributors: [],
      },
    ])
  })

  test('fractional values inside the declared tolerance pass', () => {
    const audit = auditLayoutSnapshots(
      {...suite, scenarios: [suite.scenarios[0]!]},
      [snapshot('resting', [
        observation('composer', box(0, 52.2)),
        observation('feed-content', box(286, 100)),
        observation('sidebar-content', box(286.4, 100)),
      ])],
    )
    expect(audit.scenarios[0]?.checks.map(check => check.kind)).toEqual(['pass', 'pass'])
  })

  test('inline sizes and direction-aware inline edges use the same contract path', () => {
    const inlineConstraints: LayoutConstraint[] = [
      {
        kind: 'equalsPixels',
        name: 'sidebar width',
        target: 'feed-content',
        metric: {kind: 'size', axis: 'inline'},
        pixels: 100,
        tolerancePx: 0,
        scenarios: ['resting'],
      },
      {
        kind: 'align',
        name: 'RTL starts align',
        targets: ['feed-content', 'sidebar-content'],
        metric: {kind: 'edge', axis: 'inline', edge: 'start'},
        tolerancePx: 0,
        scenarios: ['resting'],
      },
    ]
    const rightAligned = {...box(0, 20), direction: 'rtl' as const}
    const audit = auditLayoutSnapshots(
      {...suite, constraints: inlineConstraints, scenarios: [suite.scenarios[0]!]},
      [snapshot('resting', [
        observation('feed-content', rightAligned),
        observation('sidebar-content', {...rightAligned, rect: {...rightAligned.rect!, left: 40, width: 60}}),
      ])],
    )
    expect(audit.scenarios[0]?.checks.map(check => check.kind)).toEqual(['pass', 'pass'])
  })

  test('a size failure describes the largest in-flow child along the constrained axis', () => {
    const inlineSize: LayoutConstraint = {
      kind: 'equalsPixels',
      name: 'toolbar width',
      target: 'composer',
      metric: {kind: 'size', axis: 'inline'},
      pixels: 80,
      tolerancePx: 0,
      scenarios: ['resting'],
    }
    const audit = auditLayoutSnapshots(
      {...suite, constraints: [inlineSize], scenarios: [suite.scenarios[0]!]},
      [snapshot('resting', [
        observation('composer', box(0, 20, [
          child('tall child', 100, 10),
          child('wide child', 10, 100),
        ])),
      ])],
    )
    expect(audit.scenarios[0]?.checks[0]).toMatchObject({
      kind: 'fail',
      contributors: [{label: 'wide child', outerSize: 100}],
    })
  })

  test('missing, multiple, boxless, unstable, and unsupported measurements stay unknown', () => {
    const cases: Array<{snapshot: LayoutScenarioSnapshot; reason: string}> = [
      {
        snapshot: snapshot('resting', [
          observation('feed-content', box(0, 10)),
          observation('sidebar-content', box(0, 10)),
        ]),
        reason: 'targetMissing',
      },
      {
        snapshot: snapshot('resting', [
          observation('composer', box(0, 52), box(0, 52)),
          observation('feed-content', box(0, 10)),
          observation('sidebar-content', box(0, 10)),
        ]),
        reason: 'targetMatchedMultiple',
      },
      {
        snapshot: snapshot('resting', [
          observation('composer', {...box(0, 52), rect: null}),
          observation('feed-content', box(0, 10)),
          observation('sidebar-content', box(0, 10)),
        ]),
        reason: 'targetHasNoPrincipalBox',
      },
      {
        snapshot: {...snapshot('resting', []), stable: false},
        reason: 'unstableGeometry',
      },
      {
        snapshot: snapshot('resting', [
          observation('composer', {...box(0, 52), writingMode: 'vertical-rl'}),
          observation('feed-content', box(0, 10)),
          observation('sidebar-content', box(0, 10)),
        ]),
        reason: 'unsupportedWritingMode',
      },
    ]

    for (const testCase of cases) {
      const audit = auditLayoutSnapshots({...suite, scenarios: [suite.scenarios[0]!]}, [testCase.snapshot])
      expect(audit.scenarios[0]?.checks[0]).toMatchObject({kind: 'unknown', reason: {kind: testCase.reason}})
    }
  })

  test('missing and failed scenario captures never become passes', () => {
    const missing = auditLayoutSnapshots({...suite, scenarios: [suite.scenarios[0]!]}, [])
    expect(missing.scenarios[0]?.checks[0]).toMatchObject({
      kind: 'unknown',
      reason: {kind: 'scenarioMissing'},
    })

    const failed = auditLayoutSnapshots({...suite, scenarios: [suite.scenarios[0]!]}, [
      {kind: 'failed', scenario: 'resting', message: 'route did not load'},
    ])
    expect(failed.scenarios[0]?.checks[0]).toMatchObject({
      kind: 'unknown',
      reason: {kind: 'scenarioFailed', message: 'route did not load'},
    })
  })

  test('the report separates failures from unknown coverage', () => {
    const audit = auditLayoutSnapshots({...suite, scenarios: [suite.scenarios[1]!]}, [
      snapshot('with-button', [
        observation('composer', box(0, 54, [child('search button', 52)])),
        observation('feed-content', box(286, 100)),
      ]),
    ])
    const report = formatLayoutReport(audit)
    expect(report).toContain('error [layout-size]: resting composer height measured 54px; expected 52px ±0.25px (+2px)')
    expect(report).toContain('largest in-flow direct child margin box: search button is 52px')
    expect(report).toContain("unknown [layout-coverage]: content starts align — target 'sidebar-content' did not render")
    expect(report).toContain('layout contracts: 0/2 passed; 1 failed; 1 unknown')
  })
})

function snapshot(
  scenario: string,
  targets: LayoutTargetObservation[],
): Extract<LayoutScenarioSnapshot, {kind: 'captured'}> {
  return {kind: 'captured', scenario, stable: true, targets}
}

function observation(target: string, ...matches: LayoutBox[]): LayoutTargetObservation {
  return {target, selector: `#${target}`, invalidSelector: false, matches}
}

function box(top: number, height: number, children: LayoutBox['children'] = []): LayoutBox {
  return {
    rect: {top, right: 100, bottom: top + height, left: 0, width: 100, height},
    writingMode: 'horizontal-tb',
    direction: 'ltr',
    display: 'flex',
    children,
  }
}

function child(
  label: string,
  height: number,
  width = 40,
  position = 'static',
): LayoutBox['children'][number] {
  return {
    label,
    selector: `#composer > ${label.replaceAll(' ', '-')}`,
    position,
    rect: {top: 0, right: width, bottom: height, left: 0, width, height},
    marginTop: 0,
    marginRight: 0,
    marginBottom: 0,
    marginLeft: 0,
  }
}
