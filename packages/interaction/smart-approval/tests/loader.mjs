/** Isolated tests: real Cordis, approval service and assembler; no provider/network/remote projection runtime. */
import { createRequire } from 'node:module'
import { readFile, stat } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve as pathResolve } from 'node:path'
const require = createRequire(import.meta.url)
const ts = require(process.env.DSH_TEST_TYPESCRIPT || 'typescript')
const root = fileURLToPath(new URL('../../../../', import.meta.url))
const raw = await readFile(pathResolve(root, 'tsconfig.base.json'), 'utf8')
const aliases = ts.parseConfigFileTextToJson('tsconfig.base.json', raw).config.compilerOptions.paths
export async function resolve(specifier, context, next) {
  if (specifier === '@deepseek-ai/dsh-llm') return { url: new URL('./llm-facade.mjs', import.meta.url).href, shortCircuit: true }
  if (specifier === '@deepseek-ai/dsh-permission-presets') return { url: new URL('./preset-facade.mjs', import.meta.url).href, shortCircuit: true }
  if (aliases[specifier]) {
    const target = pathResolve(root, aliases[specifier][0])
    const entry = (await stat(target)).isDirectory() ? pathResolve(target, 'index.ts') : target
    return { url: pathToFileURL(entry).href, shortCircuit: true }
  }
  const match = /^(.*)\/src\/(.*)$/.exec(specifier)
  if (match && aliases[match[1]]) {
    const base = pathResolve(root, aliases[match[1]][0])
    const directory = (await stat(base)).isDirectory() ? base : dirname(base)
    return { url: pathToFileURL(pathResolve(directory, match[2])).href, shortCircuit: true }
  }
  return next(specifier, context)
}
export async function load(url, context, next) {
  if (!/\.tsx?$/.test(url)) return next(url, context)
  const source = await readFile(new URL(url), 'utf8')
  const compiled = ts.transpileModule(source, { fileName: fileURLToPath(url), compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX,
  }, reportDiagnostics: true })
  if (compiled.diagnostics?.some(item => item.category === ts.DiagnosticCategory.Error)) throw new Error(ts.formatDiagnosticsWithColorAndContext(compiled.diagnostics, { getCanonicalFileName: value => value, getCurrentDirectory: () => root, getNewLine: () => '\n' }))
  return { format: 'module', source: compiled.outputText, shortCircuit: true }
}
