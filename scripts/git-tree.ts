/** Read a committed Git tree exactly as stored, shared by the release builder, verifier, and upgrade CLI. */
import { execFileSync } from 'node:child_process'
import { buildSourceTree, ownedByPrefixes, updaterOwnedPaths, type SourceTree } from '../src/updates.ts'

export interface GitTree {
  /** Every blob in the tree by path; a symbolic link's blob is its target path. */
  files: Map<string, Uint8Array>
  /** Paths that are not regular files (symbolic links). Release archives skip these. */
  links: string[]
}

const git = (args: string[], cwd: string, input?: string) =>
  execFileSync('git', args, { cwd, input, maxBuffer: 512 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] })

/** The blobs of `ref` (HEAD, a tag, or any commit), never the working tree. */
export function gitTree(ref: string, cwd = process.cwd()): GitTree {
  const entries = git(['ls-tree', '-r', '-z', '--full-tree', ref], cwd).toString('utf8').split('\0').filter(Boolean).map((line) => {
    const tab = line.indexOf('\t')
    const [mode, type, sha] = line.slice(0, tab).split(' ') as [string, string, string]
    return { mode, type, sha, path: line.slice(tab + 1) }
  }).filter((entry) => entry.type === 'blob')
  const files = new Map<string, Uint8Array>()
  if (entries.length === 0) return { files, links: [] }
  // One `cat-file --batch` process for the whole tree: "<sha> blob <size>\n<bytes>\n" per object.
  const out = git(['cat-file', '--batch'], cwd, `${entries.map((entry) => entry.sha).join('\n')}\n`)
  let offset = 0
  for (const entry of entries) {
    const newline = out.indexOf(0x0a, offset)
    const [sha, type, size] = out.subarray(offset, newline).toString('utf8').split(' ')
    if (sha !== entry.sha || type !== 'blob') throw new Error(`git cat-file returned an unexpected object for ${entry.path}`)
    const start = newline + 1
    const end = start + Number(size)
    files.set(entry.path, new Uint8Array(out.subarray(start, end)))
    offset = end + 1
  }
  return { files, links: entries.filter((entry) => entry.mode === '120000').map((entry) => entry.path) }
}

// Attributes that make `git archive` (and so GitHub's codeload tarballs) differ from the
// committed blobs: excluded files, keyword substitution, and line-ending or filter conversion.
const ARCHIVE_ATTRIBUTES = /\b(?:export-ignore|export-subst|ident|filter|eol|text|crlf)\b/

/**
 * The signed source tree of a release: the updater-owned files at `ref`, hashed as GitHub serves
 * them in the tag's archive. Refuses trees where the archive would not match the committed blobs.
 */
export async function releaseSourceTree(ref: string, cwd = process.cwd()): Promise<SourceTree> {
  const { files, links } = gitTree(ref, cwd)
  const owned = updaterOwnedPaths(files.get('statusping.release.json'))
  if (!owned) throw new Error('statusping.release.json is missing or declares no updater-owned paths')
  const linked = links.filter((path) => path === 'statusping.release.json' || ownedByPrefixes(path, owned))
  if (linked.length) throw new Error(`Updater-owned paths must be regular files, not symbolic links: ${linked.join(', ')}`)
  for (const [path, bytes] of files) {
    if (path.split('/').at(-1) !== '.gitattributes') continue
    const rules = Buffer.from(bytes).toString('utf8').split('\n').filter((line) => !line.trim().startsWith('#'))
    if (rules.some((line) => ARCHIVE_ATTRIBUTES.test(line))) throw new Error(`${path} sets attributes that change release archives; the signed source tree would not match them`)
  }
  return buildSourceTree(files)
}
