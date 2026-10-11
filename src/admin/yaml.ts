import { type Document, isAlias, isMap, isScalar, isSeq, LineCounter, type Node, parseAllDocuments, parseDocument, stringify } from 'yaml'

const MAX_YAML_BYTES = 256 * 1024
const MAX_YAML_DEPTH = 32

/**
 * Parse an administrator-supplied YAML document into JSON-shaped data only.
 * YAML is deliberately a presentation/import format: no tags, aliases, multiple
 * documents, non-string map keys, or executable/custom values are accepted.
 */
export function parseAdminYaml(source: string): unknown {
  if (source.length > MAX_YAML_BYTES) throw new Error(`Configuration is too large (maximum ${MAX_YAML_BYTES} characters).`)
  const lineCounter = new LineCounter()
  const at = (offset: number | undefined) => {
    if (offset === undefined) return ''
    const { line, col } = lineCounter.linePos(offset)
    return `Line ${line}, column ${col}: `
  }
  const documents = parseAllDocuments(source, { schema: 'core', uniqueKeys: true, merge: false, prettyErrors: false, lineCounter })
  if (!Array.isArray(documents) || documents.length !== 1) throw new Error('Configuration must contain exactly one YAML document.')
  const document = documents[0]!
  if (document.errors.length) {
    const error = document.errors[0]!
    const { line, col } = lineCounter.linePos(error.pos[0])
    throw new Error(`Configuration YAML is invalid at line ${line}, column ${col}: ${error.message.split('\n')[0]}`)
  }
  if (!document.contents) throw new Error('Configuration must be a YAML object.')

  validateNode(document.contents, '$', 0, at)
  let value: unknown
  try {
    value = document.toJS({ mapAsMap: false, maxAliasCount: 0 })
  } catch (error) {
    throw new Error(`Configuration YAML is invalid: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!isPlainObject(value)) throw new Error('Configuration must be a YAML object.')
  return value
}

/** The comment line that lets YAML-aware editors validate and complete the file. */
export const schemaHeader = (schemaUrl: string) => `# yaml-language-server: $schema=${schemaUrl}\n`

/** Produces portable YAML for the browser editor; secrets remain environment references. */
export function stringifyAdminYaml(value: unknown): string {
  return stringify(value, { indent: 2, lineWidth: 0 })
}

/** The configuration as a downloadable file: the saved YAML text when there is one, with the schema line on top. */
export function exportAdminYaml(value: unknown, savedText: string | null, schemaUrl: string): string {
  const body = (savedText ?? stringifyAdminYaml(value)).replace(/^# yaml-language-server: \$schema=.*\n/, '')
  return `${schemaHeader(schemaUrl)}${body}`
}

/**
 * Prefixes each validation problem with the line it is about, when the problem names a path
 * (`sinks.slack.webhookUrl: …`, `monitor "api": …`, `page "status": …`, `maintenance[0]: …`).
 */
export function locateProblems(source: string, message: string): string {
  let document: Document
  const lineCounter = new LineCounter()
  try { document = parseDocument(source, { lineCounter, prettyErrors: false }) } catch { return message }
  if (document.errors.length) return message
  const lineOf = (path: Array<string | number>): number | null => {
    for (let length = path.length; length > 0; length--) {
      const node = document.getIn(path.slice(0, length), true) as Node | undefined
      if (node && typeof node === 'object' && 'range' in node && node.range) return lineCounter.linePos(node.range[0]).line
    }
    return null
  }
  const plain = document.toJS({ maxAliasCount: 0 }) as Record<string, unknown> | null
  const monitorPath = (id: string): Array<string | number> | null => {
    const groups = Array.isArray(plain?.groups) ? plain!.groups as Array<{ monitors?: Array<{ id?: unknown }> }> : []
    for (const [g, group] of groups.entries()) {
      const m = (group?.monitors ?? []).findIndex((monitor) => monitor?.id === id)
      if (m >= 0) return ['groups', g, 'monitors', m]
    }
    return null
  }
  const pagePath = (slug: string): Array<string | number> | null => {
    const pages = Array.isArray(plain?.pages) ? plain!.pages as Array<{ slug?: unknown }> : []
    const index = pages.findIndex((page) => page?.slug === slug)
    return index >= 0 ? ['pages', index] : null
  }
  const locate = (problem: string): string => {
    let path: Array<string | number> | null = null
    let match = /^monitor "([^"]+)"/.exec(problem)
    if (match) path = monitorPath(match[1]!)
    else if ((match = /^page "([^"]+)"/.exec(problem))) path = pagePath(match[1]!)
    else if ((match = /^([A-Za-z_$][\w$-]*(?:(?:\.[\w$-]+)|\[\d+\])*)[:\s]/.exec(problem))) {
      path = match[1]!.split(/\.|\[(\d+)\]/).filter((part) => part !== undefined && part !== '').map((part) => (/^\d+$/.test(part) ? Number(part) : part))
    }
    const line = path ? lineOf(path) : null
    return line ? `Line ${line}: ${problem}` : problem
  }
  return message.split('\n').map((line) => {
    const item = /^(\s*- )(.*)$/.exec(line)
    if (item) return `${item[1]}${locate(item[2]!)}`
    return /:\n|^(Invalid|Unsafe|Over)/.test(line) ? line : locate(line)
  }).join('\n')
}


function validateNode(node: unknown, path: string, depth: number, at: (offset: number | undefined) => string): void {
  const where = at((node as { range?: [number] } | null)?.range?.[0])
  if (depth > MAX_YAML_DEPTH) throw new Error(`${where}Configuration is nested too deeply near ${path}.`)
  if (isAlias(node)) throw new Error(`${where}YAML aliases are not allowed (${path}).`)
  if (isScalar(node)) {
    if (node.tag && node.tag !== 'tag:yaml.org,2002:str' && node.tag !== 'tag:yaml.org,2002:null' && node.tag !== 'tag:yaml.org,2002:bool' && node.tag !== 'tag:yaml.org,2002:int' && node.tag !== 'tag:yaml.org,2002:float') {
      throw new Error(`${where}YAML tags are not allowed (${path}).`)
    }
    return
  }
  if (isSeq(node)) {
    if (node.anchor || node.tag) throw new Error(`${where}YAML anchors and tags are not allowed (${path}).`)
    node.items.forEach((item, index) => { if (item) validateNode(item, `${path}[${index}]`, depth + 1, at) })
    return
  }
  if (isMap(node)) {
    if (node.anchor || node.tag) throw new Error(`${where}YAML anchors and tags are not allowed (${path}).`)
    for (const pair of node.items) {
      if (!isScalar(pair.key) || typeof pair.key.value !== 'string') throw new Error(`${where}YAML keys must be strings (${path}).`)
      if (pair.value) validateNode(pair.value, `${path}.${pair.key.value}`, depth + 1, at)
    }
    return
  }
  throw new Error(`${where}Unsupported YAML value at ${path}.`)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
