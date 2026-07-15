import type {
  LayoutAlignmentInference,
  LayoutAxis,
  LayoutConstraint,
  LayoutMetric,
  LayoutScenario,
  LayoutSourceTarget,
  LayoutSuite,
  LayoutTarget,
} from './model.ts'

export function parseLayoutSuite(value: unknown): LayoutSuite {
  const root = record(value, 'layout suite')
  exactKeys(root, ['baseUrl', 'targets', 'scenarios', 'constraints', 'inferAlignments'], 'layout suite')
  const baseUrl = optionalString(root['baseUrl'], 'layout suite.baseUrl')
  if (baseUrl != null) parseAbsoluteUrl(baseUrl, 'layout suite.baseUrl')

  const targets = array(root['targets'], 'layout suite.targets').map((target, index) =>
    parseTarget(target, `layout suite.targets[${index}]`))
  const scenarios = array(root['scenarios'], 'layout suite.scenarios').map((scenario, index) =>
    parseScenario(scenario, `layout suite.scenarios[${index}]`, baseUrl))
  const constraints = array(root['constraints'], 'layout suite.constraints').map((constraint, index) =>
    parseConstraint(constraint, `layout suite.constraints[${index}]`))
  const inferAlignments = optionalArray(root['inferAlignments'], 'layout suite.inferAlignments')
    .map((inference, index) => parseAlignmentInference(inference, `layout suite.inferAlignments[${index}]`))

  uniqueNames(targets, 'target')
  uniqueNames(scenarios, 'scenario')
  uniqueNames(constraints, 'constraint')
  uniqueNames(inferAlignments, 'alignment inference')

  const targetNames = new Set(targets.map(target => target.name))
  const scenarioNames = new Set(scenarios.map(scenario => scenario.name))
  for (const constraint of constraints) {
    const referencedTargets = constraint.kind === 'equalsPixels' ? [constraint.target] : constraint.targets
    for (const target of referencedTargets) {
      if (!targetNames.has(target)) {
        throw new Error(`Layout constraint '${constraint.name}' references unknown target '${target}'.`)
      }
    }
    for (const scenario of constraint.scenarios) {
      if (!scenarioNames.has(scenario)) {
        throw new Error(`Layout constraint '${constraint.name}' references unknown scenario '${scenario}'.`)
      }
    }
  }
  for (const inference of inferAlignments) {
    for (const track of inference.tracks) {
      if (!targetNames.has(track)) {
        throw new Error(`Layout alignment inference '${inference.name}' references unknown target '${track}'.`)
      }
    }
    for (const scenario of inference.scenarios) {
      if (!scenarioNames.has(scenario)) {
        throw new Error(`Layout alignment inference '${inference.name}' references unknown scenario '${scenario}'.`)
      }
    }
  }

  return {targets, scenarios, constraints, inferAlignments}
}

function parseAlignmentInference(value: unknown, path: string): LayoutAlignmentInference {
  const inference = record(value, path)
  exactKeys(inference, ['name', 'tracks', 'axis', 'tolerancePx', 'scenarios'], path)
  const tracks = stringArray(inference['tracks'], `${path}.tracks`)
  if (tracks.length < 2) throw new Error(`${path}.tracks must contain at least two targets.`)
  if (new Set(tracks).size !== tracks.length) throw new Error(`${path}.tracks must not repeat a target.`)
  return {
    name: nonEmptyString(inference['name'], `${path}.name`),
    tracks: tracks as [string, string, ...string[]],
    axis: layoutAxis(inference['axis'], `${path}.axis`),
    tolerancePx: nonnegativeFiniteNumber(inference['tolerancePx'], `${path}.tolerancePx`),
    scenarios: nonEmptyStringArray(inference['scenarios'], `${path}.scenarios`),
  }
}

function parseTarget(value: unknown, path: string): LayoutTarget {
  const target = record(value, path)
  exactKeys(target, ['name', 'selector', 'source'], path)
  const source = target['source'] === undefined ? null : parseSourceTarget(target['source'], `${path}.source`)
  const selector = nonEmptyString(target['selector'], `${path}.selector`)
  if (source != null) {
    const expectedSelector = `[data-fr-layout="${source.marker}"]`
    if (selector !== expectedSelector) {
      throw new Error(`${path}.selector must be '${expectedSelector}' when ${path}.source is set.`)
    }
  }
  return {
    name: nonEmptyString(target['name'], `${path}.name`),
    selector,
    ...(source == null ? {} : {source}),
  }
}

function parseSourceTarget(value: unknown, path: string): LayoutSourceTarget {
  const source = record(value, path)
  exactKeys(source, ['kind', 'file', 'marker'], path)
  const kind = nonEmptyString(source['kind'], `${path}.kind`)
  if (kind !== 'jsx') throw new Error(`${path}.kind must be 'jsx'.`)
  const marker = nonEmptyString(source['marker'], `${path}.marker`)
  if (!/^[A-Za-z0-9_-]+$/.test(marker)) {
    throw new Error(`${path}.marker may contain only letters, numbers, underscores, and hyphens.`)
  }
  return {
    kind,
    file: nonEmptyString(source['file'], `${path}.file`),
    marker,
  }
}

function parseScenario(value: unknown, path: string, baseUrl: string | null): LayoutScenario {
  const scenario = record(value, path)
  exactKeys(scenario, ['name', 'url', 'viewport', 'readySelector'], path)
  const viewportPath = `${path}.viewport`
  const viewport = record(scenario['viewport'], viewportPath)
  exactKeys(viewport, ['width', 'height'], viewportPath)
  const rawUrl = nonEmptyString(scenario['url'], `${path}.url`)
  let url: URL
  try {
    url = baseUrl == null ? new URL(rawUrl) : new URL(rawUrl, baseUrl)
  } catch {
    throw new Error(`${path}.url must be absolute unless layout suite.baseUrl is set.`)
  }
  return {
    name: nonEmptyString(scenario['name'], `${path}.name`),
    url: url.href,
    readySelector: nonEmptyString(scenario['readySelector'], `${path}.readySelector`),
    viewport: {
      width: positiveInteger(viewport['width'], `${viewportPath}.width`),
      height: positiveInteger(viewport['height'], `${viewportPath}.height`),
    },
  }
}

function parseConstraint(value: unknown, path: string): LayoutConstraint {
  const constraint = record(value, path)
  const kind = nonEmptyString(constraint['kind'], `${path}.kind`)
  switch (kind) {
    case 'equalsPixels': {
      exactKeys(constraint, ['kind', 'name', 'target', 'metric', 'pixels', 'tolerancePx', 'scenarios'], path)
      const metric = parseMetric(constraint['metric'], `${path}.metric`)
      if (metric.kind !== 'size') throw new Error(`${path}.metric must be a size metric.`)
      return {
        kind,
        name: nonEmptyString(constraint['name'], `${path}.name`),
        target: nonEmptyString(constraint['target'], `${path}.target`),
        metric,
        pixels: nonnegativeFiniteNumber(constraint['pixels'], `${path}.pixels`),
        tolerancePx: nonnegativeFiniteNumber(constraint['tolerancePx'], `${path}.tolerancePx`),
        scenarios: nonEmptyStringArray(constraint['scenarios'], `${path}.scenarios`),
      }
    }
    case 'align': {
      exactKeys(constraint, ['kind', 'name', 'targets', 'metric', 'tolerancePx', 'scenarios'], path)
      const metric = parseMetric(constraint['metric'], `${path}.metric`)
      if (metric.kind !== 'edge') throw new Error(`${path}.metric must be an edge metric.`)
      const targets = stringArray(constraint['targets'], `${path}.targets`)
      if (targets.length < 2) throw new Error(`${path}.targets must contain at least two targets.`)
      if (new Set(targets).size !== targets.length) throw new Error(`${path}.targets must not repeat a target.`)
      return {
        kind,
        name: nonEmptyString(constraint['name'], `${path}.name`),
        targets: targets as [string, string, ...string[]],
        metric,
        tolerancePx: nonnegativeFiniteNumber(constraint['tolerancePx'], `${path}.tolerancePx`),
        scenarios: nonEmptyStringArray(constraint['scenarios'], `${path}.scenarios`),
      }
    }
    default: throw new Error(`${path}.kind must be 'equalsPixels' or 'align'.`)
  }
}

function parseMetric(value: unknown, path: string): LayoutMetric {
  const metric = record(value, path)
  const kind = nonEmptyString(metric['kind'], `${path}.kind`)
  switch (kind) {
    case 'size':
      exactKeys(metric, ['kind', 'axis'], path)
      return {kind, axis: layoutAxis(metric['axis'], `${path}.axis`)}
    case 'edge': {
      exactKeys(metric, ['kind', 'axis', 'edge'], path)
      const edge = nonEmptyString(metric['edge'], `${path}.edge`)
      if (edge !== 'start' && edge !== 'end' && edge !== 'center') {
        throw new Error(`${path}.edge must be 'start', 'end', or 'center'.`)
      }
      return {kind, axis: layoutAxis(metric['axis'], `${path}.axis`), edge}
    }
    default: throw new Error(`${path}.kind must be 'size' or 'edge'.`)
  }
}

function layoutAxis(value: unknown, path: string): LayoutAxis {
  if (value !== 'block' && value !== 'inline') throw new Error(`${path} must be 'block' or 'inline'.`)
  return value
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value == null || Array.isArray(value)) {
    throw new Error(`${path} must be an object.`)
  }
  return value as Record<string, unknown>
}

function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array.`)
  return value
}

function optionalArray(value: unknown, path: string): unknown[] {
  return value === undefined ? [] : array(value, path)
}

function nonEmptyString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${path} must be a non-empty string.`)
  return value
}

function optionalString(value: unknown, path: string): string | null {
  if (value === undefined) return null
  return nonEmptyString(value, path)
}

function finiteNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${path} must be a finite number.`)
  return value
}

function nonnegativeFiniteNumber(value: unknown, path: string): number {
  const number = finiteNumber(value, path)
  if (number < 0) throw new Error(`${path} must be nonnegative.`)
  return number
}

function positiveInteger(value: unknown, path: string): number {
  const number = finiteNumber(value, path)
  if (!Number.isInteger(number) || number <= 0) throw new Error(`${path} must be a positive integer.`)
  return number
}

function stringArray(value: unknown, path: string): string[] {
  return array(value, path).map((item, index) => nonEmptyString(item, `${path}[${index}]`))
}

function nonEmptyStringArray(value: unknown, path: string): [string, ...string[]] {
  const values = stringArray(value, path)
  if (values.length === 0) throw new Error(`${path} must contain at least one scenario.`)
  if (new Set(values).size !== values.length) throw new Error(`${path} must not repeat a scenario.`)
  return values as [string, ...string[]]
}

function exactKeys(value: Record<string, unknown>, allowed: string[], path: string): void {
  const allowedSet = new Set(allowed)
  const unknown = Object.keys(value).find(key => !allowedSet.has(key))
  if (unknown != null) throw new Error(`${path} has unknown field '${unknown}'.`)
}

function uniqueNames(values: Array<{name: string}>, kind: string): void {
  const seen = new Set<string>()
  for (const value of values) {
    if (seen.has(value.name)) throw new Error(`Duplicate layout ${kind} name '${value.name}'.`)
    seen.add(value.name)
  }
}

function parseAbsoluteUrl(value: string, path: string): URL {
  try {
    return new URL(value)
  } catch {
    throw new Error(`${path} must be an absolute URL.`)
  }
}
