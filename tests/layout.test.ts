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
  inferAlignments: [],
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

  test('marked tracks infer ordered child-band alignment without creating contract failures', () => {
    const inference = {
      name: 'gallery columns',
      tracks: ['feed-track', 'sidebar-track'] as [string, string],
      axis: 'block' as const,
      tolerancePx: 0.5,
      scenarios: ['resting'] as [string],
    }
    const audit = auditLayoutSnapshots(
      {...suite, constraints: [], inferAlignments: [inference], scenarios: [suite.scenarios[0]!]},
      [snapshot('resting', [
        observation('feed-track', box(0, 500, [
          trackChild('feed controls', 230, 'controls'),
          trackChild('feed content', 286, 'content'),
        ])),
        observation('sidebar-track', box(0, 500, [
          trackChild('sidebar controls', 230, 'controls'),
          trackChild('sidebar content', 316, 'content'),
        ])),
      ])],
    )

    expect(audit.scenarios[0]?.checks).toEqual([])
    expect(audit.scenarios[0]?.inferences).toEqual([{
      kind: 'candidate',
      scenario: 'resting',
      inference: 'gallery columns',
      confidence: 'strong',
      axis: 'block',
      childIndex: 1,
      band: 'content',
      tolerancePx: 0.5,
      deltaPx: 30,
      evidence: [
        {track: 'feed-track', child: 'feed content', selector: '#feed-track > feed-content', position: 286},
        {track: 'sidebar-track', child: 'sidebar content', selector: '#sidebar-track > sidebar-content', position: 316},
      ],
    }])
  })

  test('unmarked and structurally different tracks remain visibly ambiguous', () => {
    const inference = {
      name: 'gallery columns',
      tracks: ['feed-track', 'sidebar-track'] as [string, string],
      axis: 'block' as const,
      tolerancePx: 0.5,
      scenarios: ['resting'] as [string],
    }
    const ambiguous = auditLayoutSnapshots(
      {...suite, constraints: [], inferAlignments: [inference], scenarios: [suite.scenarios[0]!]},
      [snapshot('resting', [
        observation('feed-track', box(0, 500, [trackChild('feed content', 286)])),
        observation('sidebar-track', box(0, 500, [trackChild('sidebar content', 316)])),
      ])],
    )
    expect(ambiguous.scenarios[0]?.inferences[0]).toMatchObject({
      kind: 'candidate',
      confidence: 'ambiguous',
      deltaPx: 30,
    })
    expect(formatLayoutReport(ambiguous)).toContain('ambiguous [layout-alignment-candidate]')

    const differentStructures = auditLayoutSnapshots(
      {...suite, constraints: [], inferAlignments: [inference], scenarios: [suite.scenarios[0]!]},
      [snapshot('resting', [
        observation('feed-track', box(0, 500, [trackChild('feed controls', 230), trackChild('feed content', 286)])),
        observation('sidebar-track', box(0, 500, [trackChild('sidebar content', 316)])),
      ])],
    )
    expect(differentStructures.scenarios[0]?.inferences[0]).toMatchObject({
      kind: 'ambiguous',
      reason: {kind: 'trackChildCountMismatch', counts: [2, 1]},
    })
    expect(formatLayoutReport(differentStructures)).toContain('could not pair direct children by order')
  })

  test('aligned tracks remain visible while weak band markers do not create strong suggestions', () => {
    const inference = {
      name: 'gallery columns',
      tracks: ['feed-track', 'sidebar-track'] as [string, string],
      axis: 'block' as const,
      tolerancePx: 0.5,
      scenarios: ['resting'] as [string],
    }
    const aligned = auditLayoutSnapshots(
      {...suite, constraints: [], inferAlignments: [inference], scenarios: [suite.scenarios[0]!]},
      [snapshot('resting', [
        observation('feed-track', box(0, 500, [trackChild('feed content', 286, 'content')])),
        observation('sidebar-track', box(0, 500, [trackChild('sidebar content', 286, 'content')])),
      ])],
    )
    expect(aligned.scenarios[0]?.inferences).toEqual([{
      kind: 'aligned',
      scenario: 'resting',
      inference: 'gallery columns',
    }])
    expect(formatLayoutReport(aligned)).toContain(
      'alignment inference: 1 aligned; 0 strong suggestions; 0 ambiguous; 0 unknown',
    )

    const weakBandSets = [
      {controls: 'controls', content: ''},
      {controls: 'content', content: 'content'},
    ]
    for (const bands of weakBandSets) {
      const duplicatedBand = auditLayoutSnapshots(
        {...suite, constraints: [], inferAlignments: [inference], scenarios: [suite.scenarios[0]!]},
        [snapshot('resting', [
          observation('feed-track', box(0, 500, [
            trackChild('feed controls', 230, bands.controls),
            trackChild('feed content', 286, bands.content),
          ])),
          observation('sidebar-track', box(0, 500, [
            trackChild('sidebar controls', 230, bands.controls),
            trackChild('sidebar content', 316, bands.content),
          ])),
        ])],
      )
      expect(duplicatedBand.scenarios[0]?.inferences[0]).toMatchObject({
        kind: 'candidate',
        confidence: 'ambiguous',
      })
    }
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
    band: null,
    position,
    rect: {top: 0, right: width, bottom: height, left: 0, width, height},
    marginTop: 0,
    marginRight: 0,
    marginBottom: 0,
    marginLeft: 0,
  }
}

function trackChild(label: string, top: number, band: string | null = null): LayoutBox['children'][number] {
  const value = child(label, 40)
  return {
    ...value,
    selector: `#${label.startsWith('feed') ? 'feed' : 'sidebar'}-track > ${label.replaceAll(' ', '-')}`,
    band,
    rect: {...value.rect, top, bottom: top + value.rect.height},
  }
}
