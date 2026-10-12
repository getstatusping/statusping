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
// committed blobs: excluded files, keyword substitution, and line-ending, encoding, or filter
// conversion.
const ARCHIVE_ATTRIBUTES = /\b(?:export-ignore|export-subst|ident|filter|eol|text|crlf|working-tree-encoding|encoding)\b/

const utf8 = new TextDecoder()
const tarString = (block: Uint8Array, start: number, length: number) => {
  const field = block.subarray(start, start + length)
  const end = field.indexOf(0)
  return utf8.decode(end === -1 ? field : field.subarray(0, end))
}

/** The `path` record of a pax extended header ("<len> key=value\n" records). */
function paxPath(data: Uint8Array): string | undefined {
  const text = utf8.decode(data)
  for (let i = 0; i < text.length;) {
    const space = text.indexOf(' ', i)
    const length = Number(text.slice(i, space))
    if (space === -1 || !Number.isSafeInteger(length) || length <= 0) break
    const record = text.slice(space + 1, i + length - 1)
    if (record.startsWith('path=')) return record.slice(5)
    i += length
  }
  return undefined
}

/** Regular files of a `git archive --format=tar` stream (ustar with pax headers), by path. */
export function readGitArchive(tar: Uint8Array): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>()
  let longPath: string | undefined
  for (let offset = 0; offset + 512 <= tar.byteLength;) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break
    const size = parseInt(tarString(header, 124, 12).trim() || '0', 8)
    const type = String.fromCharCode(header[156]!)
    const data = tar.subarray(offset + 512, offset + 512 + size)
    offset += 512 + Math.ceil(size / 512) * 512
    if (type === 'x') { longPath = paxPath(data); continue }
    if (type === 'g') continue
    const prefix = tarString(header, 345, 155)
    const path = longPath ?? (prefix ? `${prefix}/${tarString(header, 0, 100)}` : tarString(header, 0, 100))
    longPath = undefined
    if (type === '0' || type === '\0') files.set(path, new Uint8Array(data))
  }
  return files
}

/**
 * Paths where `git archive <ref>` (what GitHub's codeload serves for a tag) differs from the
 * committed blobs: a file missing from either side, or with other bytes.
 */
export function archiveMismatches(ref: string, cwd = process.cwd(), tree = gitTree(ref, cwd)): string[] {
  const archived = readGitArchive(new Uint8Array(git(['archive', '--format=tar', ref], cwd)))
  const regular = new Map([...tree.files].filter(([path]) => !tree.links.includes(path)))
  const mismatches = new Set<string>()
  for (const [path, bytes] of regular) {
    const other = archived.get(path)
    if (!other || !Buffer.from(other).equals(Buffer.from(bytes))) mismatches.add(path)
  }
  for (const path of archived.keys()) if (!regular.has(path)) mismatches.add(path)
  return [...mismatches].sort()
}

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
  // Whatever else could transform the archive (repository or global Git configuration, attribute
  // macros), the signed hashes must be the bytes the archive actually serves.
  const differ = archiveMismatches(ref, cwd, { files, links })
  if (differ.length) throw new Error(`git archive ${ref} differs from the committed files (${differ.slice(0, 5).join(', ')}${differ.length > 5 ? ', …' : ''}); the signed source tree would not match the release archive`)
  return buildSourceTree(files)
}
