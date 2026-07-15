import {existsSync, readFileSync, statSync} from 'node:fs'
import {dirname, join, resolve} from 'node:path'
import {runLayoutSuite} from './chrome.ts'
import {parseLayoutSuite} from './config.ts'
import type {LayoutSuite, StaticLayoutAudit} from './model.ts'
import {formatLayoutReport, formatStaticLayoutReport} from './report.ts'
import {runStaticLayoutSuite} from './static.ts'

const layoutConfigName = 'freerange.layout.json'

export async function runProjectLayout(searchFrom: string, configuredFile?: string): Promise<boolean> {
  const project = loadLayoutProject(searchFrom, configuredFile)
  const staticAudit = runStaticLayoutSuite(project.suite, dirname(project.configFile))
  if (staticAudit.checks.length > 0) console.log(formatStaticLayoutReport(staticAudit))
  const audit = await runLayoutSuite(project.suite)
  console.log(`${staticAudit.checks.length > 0 ? '\n' : ''}${formatLayoutReport(audit)}`)
  return staticLayoutFailed(staticAudit)
    || audit.scenarios.some(scenario => scenario.checks.some(check => check.kind !== 'pass'))
}

export function runProjectStaticLayout(searchFrom: string, configuredFile?: string): boolean {
  const project = loadLayoutProject(searchFrom, configuredFile)
  const audit = runStaticLayoutSuite(project.suite, dirname(project.configFile))
  console.log(formatStaticLayoutReport(audit))
  return staticLayoutFailed(audit)
}

function loadLayoutProject(searchFrom: string, configuredFile?: string): {configFile: string; suite: LayoutSuite} {
  const configFile = configuredFile == null
    ? findLayoutConfig(searchFrom)
    : resolve(searchFrom, configuredFile)
  if (configFile == null) {
    throw new Error(`No ${layoutConfigName} found from ${resolve(searchFrom)} or any parent directory.`)
  }
  if (!existsSync(configFile) || !statSync(configFile).isFile()) {
    throw new Error(`Layout config not found: ${configFile}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(configFile, 'utf8'))
  } catch (error) {
    throw new Error(`Could not parse ${configFile}: ${error instanceof Error ? error.message : String(error)}`)
  }
  const suite = parseLayoutSuite(parsed)
  return {configFile, suite}
}

function staticLayoutFailed(audit: StaticLayoutAudit): boolean {
  return audit.checks.some(check => check.kind !== 'pass')
}

export function findLayoutConfig(searchFrom: string): string | null {
  let directory = resolve(searchFrom)
  if (existsSync(directory) && statSync(directory).isFile()) directory = dirname(directory)
  while (true) {
    const candidate = join(directory, layoutConfigName)
    if (existsSync(candidate)) return candidate
    const parent = dirname(directory)
    if (parent === directory) return null
    directory = parent
  }
}
