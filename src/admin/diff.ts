/** Line diff for comparing two versions of the configuration YAML. */
export type DiffLine = { op: ' ' | '+' | '-'; text: string }

const MAX_CELLS = 4_000_000

/** Longest-common-subsequence line diff; very large inputs fall back to "all removed, all added". */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.replace(/\n$/, '').split('\n')
  const b = after.replace(/\n$/, '').split('\n')
  if (a.length * b.length > MAX_CELLS) return [...a.map((text) => ({ op: '-' as const, text })), ...b.map((text) => ({ op: '+' as const, text }))]
  const width = b.length + 1
  const lcs = new Uint32Array((a.length + 1) * width)
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i * width + j] = a[i] === b[j] ? lcs[(i + 1) * width + j + 1]! + 1 : Math.max(lcs[(i + 1) * width + j]!, lcs[i * width + j + 1]!)
    }
  }
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { out.push({ op: ' ', text: a[i]! }); i++; j++ }
    else if (lcs[(i + 1) * width + j]! >= lcs[i * width + j + 1]!) out.push({ op: '-', text: a[i++]! })
    else out.push({ op: '+', text: b[j++]! })
  }
  while (i < a.length) out.push({ op: '-', text: a[i++]! })
  while (j < b.length) out.push({ op: '+', text: b[j++]! })
  return out
}

/** Keeps a few unchanged lines around each change; longer unchanged runs become one gap marker (null). */
export function withContext(lines: DiffLine[], context = 3): Array<DiffLine | null> {
  const keep = lines.map((line) => line.op !== ' ')
  const near = lines.map((_, index) => {
    for (let k = Math.max(0, index - context); k <= Math.min(lines.length - 1, index + context); k++) if (keep[k]) return true
    return false
  })
  const out: Array<DiffLine | null> = []
  lines.forEach((line, index) => {
    if (near[index]) out.push(line)
    else if (out[out.length - 1] !== null) out.push(null)
  })
  return out
}
