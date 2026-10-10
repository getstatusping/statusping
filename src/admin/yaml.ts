import { isAlias, isMap, isScalar, isSeq, parseAllDocuments, stringify } from 'yaml'

const MAX_YAML_BYTES = 256 * 1024
const MAX_YAML_DEPTH = 32

/**
 * Parse an administrator-supplied YAML document into JSON-shaped data only.
 * YAML is deliberately a presentation/import format: no tags, aliases, multiple
 * documents, non-string map keys, or executable/custom values are accepted.
 */
export function parseAdminYaml(source: string): unknown {
  if (source.length > MAX_YAML_BYTES) throw new Error(`Configuration is too large (maximum ${MAX_YAML_BYTES} characters).`)
  const documents = parseAllDocuments(source, { schema: 'core', uniqueKeys: true, merge: false, prettyErrors: false })
  if (documents.length !== 1) throw new Error('Configuration must contain exactly one YAML document.')
  const document = documents[0]!
  if (document.errors.length) throw new Error(`Configuration YAML is invalid: ${document.errors[0]!.message}`)
  if (!document.contents) throw new Error('Configuration must be a YAML object.')

  validateNode(document.contents, '$', 0)
  let value: unknown
  try {
    value = document.toJS({ mapAsMap: false, maxAliasCount: 0 })
  } catch (error) {
    throw new Error(`Configuration YAML is invalid: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!isPlainObject(value)) throw new Error('Configuration must be a YAML object.')
  return value
}

/** Produces portable YAML for the browser editor; secrets remain environment references. */
export function stringifyAdminYaml(value: unknown): string {
  return stringify(value, { indent: 2, lineWidth: 0 })
}

function validateNode(node: unknown, path: string, depth: number): void {
  if (depth > MAX_YAML_DEPTH) throw new Error(`Configuration is nested too deeply near ${path}.`)
  if (isAlias(node)) throw new Error(`YAML aliases are not allowed (${path}).`)
  if (isScalar(node)) {
    if (node.tag && node.tag !== 'tag:yaml.org,2002:str' && node.tag !== 'tag:yaml.org,2002:null' && node.tag !== 'tag:yaml.org,2002:bool' && node.tag !== 'tag:yaml.org,2002:int' && node.tag !== 'tag:yaml.org,2002:float') {
      throw new Error(`YAML tags are not allowed (${path}).`)
    }
    return
  }
  if (isSeq(node)) {
    if (node.anchor || node.tag) throw new Error(`YAML anchors and tags are not allowed (${path}).`)
    node.items.forEach((item, index) => { if (item) validateNode(item, `${path}[${index}]`, depth + 1) })
    return
  }
  if (isMap(node)) {
    if (node.anchor || node.tag) throw new Error(`YAML anchors and tags are not allowed (${path}).`)
    for (const pair of node.items) {
      if (!isScalar(pair.key) || typeof pair.key.value !== 'string') throw new Error(`YAML keys must be strings (${path}).`)
      if (pair.value) validateNode(pair.value, `${path}.${pair.key.value}`, depth + 1)
    }
    return
  }
  throw new Error(`Unsupported YAML value at ${path}.`)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
