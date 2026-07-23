import type {LineBoxContainmentClaim} from './linebox.ts'
import type {
  StaticLayoutConstraint,
  StaticLayoutSourceTarget,
  StaticLayoutSuite,
  StaticLayoutTarget,
} from './model.ts'

export function parseStaticLayoutSuite(value: unknown): StaticLayoutSuite {
  const root = record(value, 'layout suite')
  exactKeys(root, ['targets', 'constraints'], 'layout suite', ['lineBoxContainment'])
  const targets = array(root['targets'], 'layout suite.targets').map((target, index) =>
    parseTarget(target, `layout suite.targets[${index}]`))
  const constraints = array(root['constraints'], 'layout suite.constraints').map((constraint, index) =>
    parseConstraint(constraint, `layout suite.constraints[${index}]`))

  const lineBoxContainment = root['lineBoxContainment'] == null
    ? []
    : array(root['lineBoxContainment'], 'layout suite.lineBoxContainment').map((claim, index) =>
      parseLineBoxClaim(claim, `layout suite.lineBoxContainment[${index}]`))

  uniqueNames(targets, 'target')
  uniqueNames(constraints, 'constraint')
  uniqueNames(lineBoxContainment, 'line-box claim')
  const targetNames = new Set(targets.map(target => target.name))
  for (const constraint of constraints) {
    if (!targetNames.has(constraint.target)) {
      throw new Error(`Layout constraint '${constraint.name}' references unknown target '${constraint.target}'.`)
    }
  }
  return {targets, constraints, lineBoxContainment}
}

function parseLineBoxClaim(value: unknown, path: string): LineBoxContainmentClaim {
  const claim = record(value, path)
  exactKeys(claim, ['name', 'context', 'inline'], path, ['assume'])
  const classList = (raw: unknown, listPath: string): [string, ...string[]] => {
    const names = array(raw, listPath).map((name, index) => {
      const text = nonEmptyString(name, `${listPath}[${index}]`)
      if (!/^[A-Za-z0-9_-]+$/.test(text)) {
        throw new Error(`${listPath}[${index}] must be a bare class name (letters, numbers, underscores, hyphens).`)
      }
      return text
    })
    if (names.length === 0) throw new Error(`${listPath} must not be empty.`)
    return names as [string, ...string[]]
  }
  let contextFontSizePx: number | null = null
  if (claim['assume'] != null) {
    const assume = record(claim['assume'], `${path}.assume`)
    exactKeys(assume, [], `${path}.assume`, ['contextFontSizePx'])
    if (assume['contextFontSizePx'] != null) {
      const px = assume['contextFontSizePx']
      if (typeof px !== 'number' || !Number.isFinite(px) || px <= 0) {
        throw new Error(`${path}.assume.contextFontSizePx must be a positive finite number.`)
      }
      contextFontSizePx = px
    }
  }
  return {
    name: nonEmptyString(claim['name'], `${path}.name`),
    context: classList(claim['context'], `${path}.context`),
    inline: classList(claim['inline'], `${path}.inline`),
    assume: {contextFontSizePx},
  }
}

function parseTarget(value: unknown, path: string): StaticLayoutTarget {
  const target = record(value, path)
  exactKeys(target, ['name', 'source'], path)
  return {
    name: nonEmptyString(target['name'], `${path}.name`),
    source: parseSourceTarget(target['source'], `${path}.source`),
  }
}

function parseSourceTarget(value: unknown, path: string): StaticLayoutSourceTarget {
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

function parseConstraint(value: unknown, path: string): StaticLayoutConstraint {
  const constraint = record(value, path)
  exactKeys(constraint, ['kind', 'name', 'target', 'pixels', 'tolerancePx', 'viewportWidths'], path)
  const kind = nonEmptyString(constraint['kind'], `${path}.kind`)
  if (kind !== 'intrinsicBlockSize') throw new Error(`${path}.kind must be 'intrinsicBlockSize'.`)
  const viewportWidths = array(constraint['viewportWidths'], `${path}.viewportWidths`)
    .map((width, index) => positiveInteger(width, `${path}.viewportWidths[${index}]`))
  if (viewportWidths.length === 0) throw new Error(`${path}.viewportWidths must not be empty.`)
  return {
    kind,
    name: nonEmptyString(constraint['name'], `${path}.name`),
    target: nonEmptyString(constraint['target'], `${path}.target`),
    pixels: nonnegativeFiniteNumber(constraint['pixels'], `${path}.pixels`),
    tolerancePx: nonnegativeFiniteNumber(constraint['tolerancePx'], `${path}.tolerancePx`),
    viewportWidths: viewportWidths as [number, ...number[]],
  }
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

function nonEmptyString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${path} must be a non-empty string.`)
  return value
}

function nonnegativeFiniteNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${path} must be a nonnegative finite number.`)
  }
  return value
}

function positiveInteger(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${path} must be a positive integer.`)
  }
  return value
}

function exactKeys(
  value: Record<string, unknown>,
  expected: string[],
  path: string,
  optional: string[] = [],
): void {
  const allowed = new Set([...expected, ...optional])
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${path} has unknown field '${key}'.`)
  }
  for (const key of expected) {
    if (!(key in value)) throw new Error(`${path}.${key} is required.`)
  }
}

function uniqueNames(values: Array<{name: string}>, kind: string): void {
  const seen = new Set<string>()
  for (const value of values) {
    if (seen.has(value.name)) throw new Error(`Duplicate layout ${kind} name '${value.name}'.`)
    seen.add(value.name)
  }
}
