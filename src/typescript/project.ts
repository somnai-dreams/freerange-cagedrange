import {dirname, isAbsolute, relative, resolve, sep} from 'node:path'
import * as ts from 'typescript'
import {TypeScriptDiagnosticsError} from './diagnostics.ts'

export type LoadedTypeScriptProject = {
  rootDirectory: string
  parsed: ts.ParsedCommandLine
  program: ts.Program
}

export type ProjectSource = {
  project: LoadedTypeScriptProject
  sourceFile: ts.SourceFile
}

export function findTypeScriptConfig(searchFrom: string): string | null {
  return ts.findConfigFile(resolve(searchFrom), file => ts.sys.fileExists(file), 'tsconfig.json') ?? null
}

export function loadTypeScriptProjectGraph(configPath: string): LoadedTypeScriptProject[] {
  const loaded: LoadedTypeScriptProject[] = []
  const byConfigPath = new Map<string, LoadedTypeScriptProject | null>()

  const load = (requestedConfigPath: string): LoadedTypeScriptProject => {
    const absoluteConfigPath = resolve(requestedConfigPath)
    const existing = byConfigPath.get(absoluteConfigPath)
    if (existing === null) {
      throw new Error(`Circular TypeScript project reference involving ${absoluteConfigPath}`)
    }
    if (existing !== undefined) return existing
    byConfigPath.set(absoluteConfigPath, null)
    const parsed = parseConfig(absoluteConfigPath)
    requireStrictNullChecks(parsed.options, absoluteConfigPath)
    for (const reference of parsed.projectReferences ?? []) load(ts.resolveProjectReferencePath(reference))
    const program = createProjectProgram(parsed)
    const project = {
      rootDirectory: dirname(absoluteConfigPath),
      parsed,
      program,
    }
    byConfigPath.set(absoluteConfigPath, project)
    loaded.push(project)
    return project
  }

  load(configPath)
  return loaded
}

// The spacing scan reads syntax only, but project membership includes files reached
// through imports and triple-slash references, not just the tsconfig's root file names.
// A Program resolves that complete source set; no checker or diagnostics are requested.
// The root options carry the entry config's output settings, e.g. `pretty`. A circular
// project reference simply terminates the walk here; the checked graph loader is where
// cycles are rejected, because only type checking depends on reference order.
export function projectFileNames(configPath: string): {fileNames: string[]; rootOptions: ts.CompilerOptions} {
  const entryConfigPath = resolve(configPath)
  const fileNames = new Set<string>()
  const visited = new Set<string>()
  let rootOptions: ts.CompilerOptions = {}

  const load = (requestedConfigPath: string): void => {
    const absoluteConfigPath = resolve(requestedConfigPath)
    if (visited.has(absoluteConfigPath)) return
    visited.add(absoluteConfigPath)
    const parsed = parseConfig(absoluteConfigPath)
    if (absoluteConfigPath === entryConfigPath) rootOptions = parsed.options
    for (const reference of parsed.projectReferences ?? []) load(ts.resolveProjectReferencePath(reference))
    const program = createProjectProgram(parsed)
    for (const sourceFile of program.getSourceFiles()) {
      if (isProjectImplementationSource(sourceFile)) fileNames.add(resolve(sourceFile.fileName))
    }
  }

  load(entryConfigPath)
  return {fileNames: [...fileNames].sort(), rootOptions}
}

export function projectSources(projects: LoadedTypeScriptProject[]): ProjectSource[] {
  const sources = new Map<string, ProjectSource>()
  for (const project of projects) {
    for (const sourceFile of project.program.getSourceFiles()) {
      if (!isProjectImplementationSource(sourceFile)) continue
      const absoluteFile = resolve(sourceFile.fileName)
      const existing = sources.get(absoluteFile)
      const candidate = {project, sourceFile}
      if (existing == null
        || ownershipScore(project, absoluteFile) > ownershipScore(existing.project, absoluteFile)) {
        sources.set(absoluteFile, candidate)
      }
    }
  }
  return [...sources.values()]
    .sort((left, right) => left.sourceFile.fileName.localeCompare(right.sourceFile.fileName))
}

function createProjectProgram(parsed: ts.ParsedCommandLine): ts.Program {
  return ts.createProgram({
    rootNames: parsed.fileNames,
    options: parsed.options,
    configFileParsingDiagnostics: parsed.errors,
    ...(parsed.projectReferences == null ? {} : {projectReferences: parsed.projectReferences}),
  })
}

function isProjectImplementationSource(sourceFile: ts.SourceFile): boolean {
  return !sourceFile.isDeclarationFile && !sourceFile.fileName.includes(`${sep}node_modules${sep}`)
}

function parseConfig(configPath: string): ts.ParsedCommandLine {
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, undefined, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: diagnostic => {
      throw new TypeScriptDiagnosticsError([diagnostic], {}, dirname(configPath))
    },
  })
  if (parsed == null) throw new Error(`TypeScript could not parse ${configPath}`)
  if (parsed.errors.length > 0) {
    throw new TypeScriptDiagnosticsError(parsed.errors, parsed.options, dirname(configPath))
  }
  return parsed
}

function requireStrictNullChecks(options: ts.CompilerOptions, configPath: string): void {
  // TypeScript 6 defaults strict mode on. An explicit strictNullChecks setting wins;
  // otherwise strict:false is the only way the effective option is disabled.
  const enabled = options.strictNullChecks ?? options.strict !== false
  if (enabled) return
  throw new Error(
    `freerange requires strictNullChecks. Enable "strict": true or "strictNullChecks": true in ${configPath}.`,
  )
}

function ownershipScore(project: LoadedTypeScriptProject, file: string): number {
  const path = relative(project.rootDirectory, file)
  const inside = path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))
  return inside ? project.rootDirectory.length : -1
}
