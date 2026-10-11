/**
 * Line-level three-way merge (diff3) for one text file: the customer's edits and the
 * release's edits are combined when they touch different lines. Overlapping edits are
 * returned with Git-style conflict markers for the customer to resolve.
 */
export type LineMerge = { clean: boolean; text: string }

const MAX_EDITS = 2000

const lines = (text: string) => text.match(/[^\n]*\n|[^\n]+$/g) ?? []

/** For each line of `a`, the matching line of `b` in a longest common subsequence (Myers), or -1. */
function matchLines(a: string[], b: string[]): Int32Array | null {
  const match = new Int32Array(a.length).fill(-1)
  let s = 0
  while (s < a.length && s < b.length && a[s] === b[s]) { match[s] = s; s++ }
  let [ea, eb] = [a.length, b.length]
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) { ea--; eb--; match[ea] = eb }
  const [n, m] = [ea - s, eb - s]
  if (n === 0 || m === 0) return match
  const max = n + m
  const off = max + 1
  const v = new Int32Array(2 * max + 3)
  const trace: Int32Array[] = []
  for (let d = 0; d <= Math.min(max, MAX_EDITS); d++) {
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1]! < v[off + k + 1]!) ? v[off + k + 1]! : v[off + k - 1]! + 1
      let y = x - k
      while (x < n && y < m && a[s + x] === b[s + y]) { x++; y++ }
      v[off + k] = x
      if (x >= n && y >= m) {
        trace.push(v.slice(off - d, off + d + 1))
        let [px, py] = [n, m]
        for (let e = d; e > 0; e--) {
          const prev = trace[e - 1]!
          const kk = px - py
          const pk = kk === -e || (kk !== e && prev[kk - 1 + e - 1]! < prev[kk + 1 + e - 1]!) ? kk + 1 : kk - 1
          const sx = prev[pk + e - 1]!
          const sy = sx - pk
          while (px > sx && py > sy) { px--; py--; match[s + px] = s + py }
          px = sx; py = sy
        }
        while (px > 0 && py > 0) { px--; py--; match[s + px] = s + py }
        return match
      }
    }
    trace.push(v.slice(off - d, off + d + 1))
  }
  return null
}

const equal = (a: string[], b: string[]) => a.length === b.length && a.every((line, i) => line === b[i])
const block = (part: string[]) => { const text = part.join(''); return text && !text.endsWith('\n') ? `${text}\n` : text }

/** Merge `ours` (the customer's file) and `theirs` (the release's) from their common `base`. Null when too different to merge. */
export function mergeLines(base: string, ours: string, theirs: string, labels = { ours: 'your version', theirs: 'StatusPing' }): LineMerge | null {
  const [o, a, b] = [lines(base), lines(ours), lines(theirs)]
  const [ma, mb] = [matchLines(o, a), matchLines(o, b)]
  if (!ma || !mb) return null
  let [i, j, k] = [0, 0, 0]
  let clean = true
  let text = ''
  while (i <= o.length) {
    let next = i
    while (next < o.length && (ma[next] === -1 || mb[next] === -1)) next++
    if (next === i && i < o.length && ma[i] === j && mb[i] === k) { text += o[i]; i++; j++; k++; continue }
    const [ea, eb] = next < o.length ? [ma[next]!, mb[next]!] : [a.length, b.length]
    const [co, ca, cb] = [o.slice(i, next), a.slice(j, ea), b.slice(k, eb)]
    if (equal(ca, co)) text += cb.join('')
    else if (equal(cb, co) || equal(ca, cb)) text += ca.join('')
    else {
      clean = false
      text += `<<<<<<< ${labels.ours}\n${block(ca)}=======\n${block(cb)}>>>>>>> ${labels.theirs}\n`
    }
    if (next >= o.length) break
    ;[i, j, k] = [next, ea, eb]
  }
  return { clean, text }
}
