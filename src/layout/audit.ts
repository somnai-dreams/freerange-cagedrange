import type {
  LayoutAlignmentInference,
  LayoutBox,
  LayoutCheck,
  LayoutConstraint,
  LayoutContributor,
  LayoutInference,
  LayoutInferenceUnknownReason,
  LayoutMetric,
  LayoutScenarioAudit,
  LayoutScenarioSnapshot,
  LayoutSuite,
  LayoutSuiteAudit,
  LayoutTargetObservation,
  LayoutUnknownReason,
} from './model.ts'

export function auditLayoutSnapshots(suite: LayoutSuite, snapshots: LayoutScenarioSnapshot[]): LayoutSuiteAudit {
  const snapshotByScenario = new Map(snapshots.map(snapshot => [snapshot.scenario, snapshot]))
  return {
    scenarios: suite.scenarios.map(scenario => {
      const constraints = suite.constraints.filter(constraint => constraint.scenarios.includes(scenario.name))
      const inferences = suite.inferAlignments.filter(inference => inference.scenarios.includes(scenario.name))
      const snapshot = snapshotByScenario.get(scenario.name)
      if (snapshot == null) {
        return {
          scenario: scenario.name,
          checks: constraints.map(constraint => unknownCheck(
            scenario.name,
            constraint.name,
            {kind: 'scenarioMissing'},
          )),
          inferences: inferences.map(inference => unknownInference(
            scenario.name,
            inference.name,
            {kind: 'scenarioMissing'},
          )),
        }
      }
      return auditScenario(snapshot, constraints, inferences)
    }),
  }
}

export function auditLayoutSnapshot(
  snapshot: LayoutScenarioSnapshot,
  constraints: LayoutConstraint[],
  inferences: LayoutAlignmentInference[] = [],
): LayoutScenarioAudit {
  return auditScenario(
    snapshot,
    constraints.filter(constraint => constraint.scenarios.includes(snapshot.scenario)),
    inferences.filter(inference => inference.scenarios.includes(snapshot.scenario)),
  )
}

function auditScenario(
  snapshot: LayoutScenarioSnapshot,
  constraints: LayoutConstraint[],
  inferences: LayoutAlignmentInference[],
): LayoutScenarioAudit {
  if (snapshot.kind === 'failed') {
    return {
      scenario: snapshot.scenario,
      checks: constraints.map(constraint => unknownCheck(
        snapshot.scenario,
        constraint.name,
        {kind: 'scenarioFailed', message: snapshot.message},
      )),
      inferences: inferences.map(inference => unknownInference(
        snapshot.scenario,
        inference.name,
        {kind: 'scenarioFailed', message: snapshot.message},
      )),
    }
  }
  if (!snapshot.stable) {
    return {
      scenario: snapshot.scenario,
      checks: constraints.map(constraint => unknownCheck(
        snapshot.scenario,
        constraint.name,
        {kind: 'unstableGeometry'},
      )),
      inferences: inferences.map(inference => unknownInference(
        snapshot.scenario,
        inference.name,
        {kind: 'unstableGeometry'},
      )),
    }
  }
  return {
    scenario: snapshot.scenario,
    checks: constraints.map(constraint => auditConstraint(snapshot, constraint)),
    inferences: inferences.flatMap(inference => auditAlignmentInference(snapshot, inference)),
  }
}

type CapturedLayoutSnapshot = Extract<LayoutScenarioSnapshot, {kind: 'captured'}>

function auditConstraint(snapshot: CapturedLayoutSnapshot, constraint: LayoutConstraint): LayoutCheck {
  switch (constraint.kind) {
    case 'equalsPixels': {
      const measured = measureTarget(snapshot, constraint.target, constraint.metric)
      if (measured.kind === 'unknown') return unknownCheck(snapshot.scenario, constraint.name, measured.reason)
      const deltaPx = measured.value - constraint.pixels
      if (Math.abs(deltaPx) <= constraint.tolerancePx) {
        return {kind: 'pass', scenario: snapshot.scenario, constraint: constraint.name, measurements: [measured.value]}
      }
      return {
        kind: 'fail',
        scenario: snapshot.scenario,
        constraint: constraint.name,
        rule: 'layout-size',
        measurements: [measured.value],
        expected: constraint.pixels,
        tolerancePx: constraint.tolerancePx,
        deltaPx,
        contributors: deltaPx > 0 ? largestContributors(measured.box, constraint.metric.axis) : [],
      }
    }
    case 'align': {
      const measurements: number[] = []
      for (const target of constraint.targets) {
        const measured = measureTarget(snapshot, target, constraint.metric)
        if (measured.kind === 'unknown') return unknownCheck(snapshot.scenario, constraint.name, measured.reason)
        measurements.push(measured.value)
      }
      const deltaPx = Math.max(...measurements) - Math.min(...measurements)
      if (deltaPx <= constraint.tolerancePx) {
        return {kind: 'pass', scenario: snapshot.scenario, constraint: constraint.name, measurements}
      }
      return {
        kind: 'fail',
        scenario: snapshot.scenario,
        constraint: constraint.name,
        rule: 'layout-alignment',
        measurements,
        expected: 'aligned',
        tolerancePx: constraint.tolerancePx,
        deltaPx,
        contributors: [],
      }
    }
  }
}

type MeasuredTarget =
  | {kind: 'measured'; value: number; box: LayoutBox}
  | {kind: 'unknown'; reason: LayoutUnknownReason}

function measureTarget(snapshot: CapturedLayoutSnapshot, target: string, metric: LayoutMetric): MeasuredTarget {
  const observation = snapshot.targets.find(candidate => candidate.target === target)
  const unresolved = unresolvedTarget(target, observation)
  if (unresolved != null) return {kind: 'unknown', reason: unresolved}
  const box = observation!.matches[0]!
  if (box.writingMode !== 'horizontal-tb') {
    return {kind: 'unknown', reason: {kind: 'unsupportedWritingMode', target, writingMode: box.writingMode}}
  }
  return {kind: 'measured', value: metricValue(box, metric), box}
}

function unresolvedTarget(target: string, observation: LayoutTargetObservation | undefined): LayoutUnknownReason | null {
  if (observation == null) return {kind: 'targetMissing', target}
  if (observation.invalidSelector) return {kind: 'invalidSelector', target, selector: observation.selector}
  if (observation.matches.length === 0) return {kind: 'targetMissing', target}
  if (observation.matches.length > 1) return {kind: 'targetMatchedMultiple', target, count: observation.matches.length}
  if (observation.matches[0]!.rect == null) return {kind: 'targetHasNoPrincipalBox', target}
  return null
}

function metricValue(box: LayoutBox, metric: LayoutMetric): number {
  const rect = box.rect!
  switch (metric.kind) {
    case 'size': return metric.axis === 'block' ? rect.height : rect.width
    case 'edge': {
      const start = metric.axis === 'block'
        ? rect.top
        : box.direction === 'rtl' ? rect.right : rect.left
      const end = metric.axis === 'block'
        ? rect.bottom
        : box.direction === 'rtl' ? rect.left : rect.right
      switch (metric.edge) {
        case 'start': return start
        case 'end': return end
        case 'center': return (start + end) / 2
      }
    }
  }
}

function largestContributors(box: LayoutBox, axis: 'block' | 'inline'): LayoutContributor[] {
  const children: LayoutContributor[] = []
  for (const child of box.children) {
    if (child.position === 'absolute' || child.position === 'fixed') continue
    const outerSize = axis === 'block'
      ? child.rect.height + child.marginTop + child.marginBottom
      : child.rect.width + child.marginLeft + child.marginRight
    children.push({label: child.label, selector: child.selector, outerSize})
  }
  const largestSize = Math.max(...children.map(child => child.outerSize))
  return children.filter(child => child.outerSize === largestSize)
}

function unknownCheck(scenario: string, constraint: string, reason: LayoutUnknownReason): LayoutCheck {
  return {kind: 'unknown', scenario, constraint, reason}
}

function auditAlignmentInference(
  snapshot: CapturedLayoutSnapshot,
  inference: LayoutAlignmentInference,
): LayoutInference[] {
  const tracks: Array<{name: string; box: LayoutBox}> = []
  for (const track of inference.tracks) {
    const observation = snapshot.targets.find(candidate => candidate.target === track)
    const unresolved = unresolvedTarget(track, observation)
    if (unresolved != null) return [unknownInference(snapshot.scenario, inference.name, unresolved)]
    const box = observation!.matches[0]!
    if (box.writingMode !== 'horizontal-tb') {
      return [unknownInference(snapshot.scenario, inference.name, {
        kind: 'unsupportedWritingMode',
        target: track,
        writingMode: box.writingMode,
      })]
    }
    tracks.push({name: track, box})
  }

  const visibleChildren = tracks.map(track => track.box.children.filter(child => child.rect.width > 0 && child.rect.height > 0))
  const counts = visibleChildren.map(children => children.length)
  if (counts.some(count => count !== counts[0])) {
    return [{
      kind: 'ambiguous',
      scenario: snapshot.scenario,
      inference: inference.name,
      reason: {
        kind: 'trackChildCountMismatch',
        tracks: tracks.map(track => track.name),
        counts,
      },
    }]
  }
  if (counts[0] === 0) {
    return [unknownInference(snapshot.scenario, inference.name, {kind: 'noVisibleTrackChildren'})]
  }

  const candidates: LayoutInference[] = []
  for (let childIndex = 0; childIndex < counts[0]!; childIndex++) {
    const children = visibleChildren.map(track => track[childIndex]!)
    const positions = children.map((child, index) => childStart(child, tracks[index]!.box, inference.axis))
    const deltaPx = Math.max(...positions) - Math.min(...positions)
    if (deltaPx <= inference.tolerancePx) continue
    const band = children[0]!.band
    const sharedBand = band != null
      && band.trim() !== ''
      && children.every(child => child.band === band)
      && visibleChildren.every(trackChildren => trackChildren.filter(child => child.band === band).length === 1)
    candidates.push({
      kind: 'candidate',
      scenario: snapshot.scenario,
      inference: inference.name,
      confidence: sharedBand ? 'strong' : 'ambiguous',
      axis: inference.axis,
      childIndex,
      band: sharedBand ? band : null,
      tolerancePx: inference.tolerancePx,
      deltaPx,
      evidence: children.map((child, index) => ({
        track: tracks[index]!.name,
        child: child.label,
        selector: child.selector,
        position: positions[index]!,
      })),
    })
  }
  return candidates.length === 0
    ? [{kind: 'aligned', scenario: snapshot.scenario, inference: inference.name}]
    : candidates
}

function childStart(child: LayoutBox['children'][number], track: LayoutBox, axis: 'block' | 'inline'): number {
  if (axis === 'block') return child.rect.top
  return track.direction === 'rtl' ? child.rect.right : child.rect.left
}

function unknownInference(
  scenario: string,
  inference: string,
  reason: LayoutInferenceUnknownReason,
): LayoutInference {
  return {kind: 'unknown', scenario, inference, reason}
}
