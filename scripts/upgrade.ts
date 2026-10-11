/**
 * Prepare a reviewable StatusPing upgrade in a Deploy Button repository.
 *
 *   npm run upgrade               # latest stable release
 *   npm run upgrade -- 0.2.0      # a specific release
 *   npm run upgrade -- --adopt    # repositories created before release markers
 *
 * Fetches the installed and target release tags from the public template,
 * plans a file-level three-way upgrade, and commits it on a new
 * `statusping/upgrade-vX.Y.Z` branch. Nothing is pushed: review the commit,
 * then push the branch and merge it through a pull request.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { MARKER_PATH, planUpgrade, WRANGLER_PATH } from '../src/upgrade-plan.ts'

const SOURCE = 'https://github.com/getstatusping/statusping.git'
const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)$/
const BLOCKING = new Set(['modified-locally', 'deleted-locally', 'added-locally', 'template-marker-missing'])

function git(args: string[]): Buffer {
  return execFileSync('git', args, { maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
}
const gitText = (args: string[]) => git(args).toString('utf8').trim()
function fail(message: string): never {
  console.error(message)
  process.exit(1)
}
const compare = (a: string, b: string) => {
  const [x, y] = [SEMVER.exec(a)!.slice(1).map(Number), SEMVER.exec(b)!.slice(1).map(Number)]
  return x[0]! - y[0]! || x[1]! - y[1]! || x[2]! - y[2]!
}

function latestTag(source: string): string {
  const tags = gitText(['ls-remote', '--tags', '--refs', source]).split('\n')
    .map((line) => line.split('refs/tags/')[1] ?? '')
    .filter((tag) => SEMVER.test(tag))
    .sort(compare)
  return tags.at(-1) ?? fail(`No release tags found at ${source}`)
}

function tree(ref: string): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>()
  for (const path of git(['ls-tree', '-r', '-z', '--name-only', ref]).toString('utf8').split('\0').filter(Boolean)) {
    files.set(path, git(['cat-file', 'blob', `${ref}:${path}`]))
  }
  return files
}

function main() {
  const args = process.argv.slice(2)
  const sourceIndex = args.indexOf('--source')
  const source = sourceIndex >= 0 ? args[sourceIndex + 1] ?? fail('--source needs a Git URL') : SOURCE
  const requested = args.find((arg, i) => SEMVER.test(arg) && args[i - 1] !== '--source')

  if (gitText(['rev-parse', '--show-toplevel']) !== process.cwd()) fail('Run this from the root of your StatusPing repository.')
  if (gitText(['status', '--porcelain'])) fail('Commit or stash your local changes first, so the upgrade is a single reviewable commit.')
  const adopt = args.includes('--adopt')
  if (!existsSync(MARKER_PATH) && !adopt) fail(`${MARKER_PATH} is missing. If this repository was created before release markers existed, rerun with --adopt.`)
  if (existsSync(MARKER_PATH) && adopt) fail(`${MARKER_PATH} already exists; --adopt is only for repositories created before it did.`)

  const installed = adopt
    ? String((JSON.parse(readFileSync('package.json', 'utf8')) as { version?: unknown }).version ?? '')
    : String((JSON.parse(readFileSync(MARKER_PATH, 'utf8')) as { release?: unknown }).release ?? '')
  if (!SEMVER.test(installed)) fail(`${adopt ? 'package.json' : MARKER_PATH} has no valid release version.`)
  const targetTag = requested ? `v${requested.replace(/^v/, '')}` : latestTag(source)
  const target = targetTag.slice(1)
  if (compare(target, installed) <= 0) {
    console.log(`Already on v${installed}; nothing to upgrade.`)
    return
  }
  const branch = `statusping/upgrade-${targetTag}`
  if (gitText(['branch', '--list', branch])) fail(`Branch ${branch} already exists. Delete it or finish reviewing it first.`)

  console.log(`Fetching ${adopt ? 'template history' : `v${installed}`} and ${targetTag} from ${source}…`)
  const baseRef = adopt ? 'refs/statusping/main' : `refs/statusping/v${installed}`
  const targetRef = `refs/statusping/${targetTag}`
  try {
    git(['fetch', '--quiet', '--no-tags', source, `+refs/${adopt ? 'heads/main' : `tags/v${installed}`}:${baseRef}`, `+refs/tags/${targetTag}:${targetRef}`])
    const next = tree(targetRef)
    let minimum = ''
    try { minimum = String((JSON.parse(new TextDecoder().decode(next.get('package.json'))) as { statusping?: { minimumUpgradeVersion?: unknown } }).statusping?.minimumUpgradeVersion ?? '') } catch { /* no minimum */ }
    if (SEMVER.test(minimum) && compare(installed, minimum) < 0) fail(`${targetTag} cannot be applied directly to v${installed}. Upgrade to v${minimum} first:\n  npm run upgrade -- ${minimum}`)
    let base: Map<string, Uint8Array>
    const current = new Map<string, Uint8Array>()
    if (adopt) {
      // Use the template commit this repository was created from as the base:
      // the one whose updater-owned files differ least from this checkout.
      const owned = (JSON.parse(new TextDecoder().decode(next.get(MARKER_PATH))) as { ownership: { updaterOwnedPaths: string[] } }).ownership.updaterOwnedPaths
      const candidates = gitText(['rev-list', baseRef]).split('\n').filter(Boolean)
      const distance = (commit: string) => gitText(['diff', '--name-only', commit, 'HEAD', '--', ...owned]).split('\n').filter(Boolean).length
      const origin = candidates.reduce((best, commit) => (distance(commit) < distance(best) ? commit : best))
      console.log(`Adopting: this repository matches template commit ${origin.slice(0, 7)} (${distance(origin)} file(s) differ).`)
      base = tree(origin)
      // Neither side has a marker yet; give both the target's contract at the installed version.
      const marker = JSON.parse(new TextDecoder().decode(next.get(MARKER_PATH))) as Record<string, unknown>
      const adopted = new TextEncoder().encode(`${JSON.stringify({ ...marker, release: installed, template: installed }, null, 2)}\n`)
      base.set(MARKER_PATH, adopted)
      current.set(MARKER_PATH, adopted)
    } else {
      base = tree(baseRef)
    }
    for (const path of new Set([...base.keys(), ...next.keys()])) {
      if (!current.has(path) && existsSync(path)) current.set(path, readFileSync(path))
    }
    const plan = planUpgrade({ base, target: next, current, currentWrangler: existsSync(WRANGLER_PATH) ? readFileSync(WRANGLER_PATH) : undefined, addTemplateVersionLine: adopt })

    if (!plan.safe) fail(`Cannot prepare this upgrade:\n${plan.errors.map((error) => `  - ${error}`).join('\n')}`)
    const blocking = plan.conflicts.filter((conflict) => BLOCKING.has(conflict.reason))
    const skip = args.includes('--skip-conflicts')
    if (plan.merged.length) {
      console.log('\nYour edits were merged with the release in (review these):')
      for (const path of plan.merged) console.log(`  - ${path}`)
    }
    if (plan.conflicts.length) {
      console.log('\nFiles that need your attention:')
      for (const { path, reason } of plan.conflicts) console.log(`  - ${path} (${reason})`)
    }
    if (blocking.length && !skip) {
      fail(`\nThese files differ from v${installed}, so the upgrade did not change them. Restore them with\n  git checkout ${baseRef} -- <path>\nor rerun with --skip-conflicts to upgrade everything else and merge them by hand (compare with ${targetRef}).`)
    }

    git(['switch', '--quiet', '-c', branch])
    for (const [path, content] of plan.writes) {
      mkdirSync(dirname(path) || '.', { recursive: true })
      writeFileSync(path, content)
    }
    for (const path of plan.deletes) rmSync(path)
    git(['add', '--all'])
    git(['commit', '--quiet', '-m', `chore: upgrade StatusPing to ${targetTag}`, '-m', `Prepared by npm run upgrade from v${installed}${adopt ? ' (adopted)' : ''}.`])
    console.log(`\nCommitted the ${targetTag} upgrade on ${branch}: ${plan.writes.size} file(s) written, ${plan.deletes.length} removed.`)
    console.log(`Review it with: git show --stat ${branch}`)
    console.log(`Then push it and open a pull request:\n  git push -u origin ${branch}`)
    console.log(`Release notes: https://github.com/getstatusping/statusping/releases/tag/${targetTag}`)
  } finally {
    for (const ref of [baseRef, targetRef]) try { git(['update-ref', '-d', ref]) } catch { /* not fetched */ }
  }
}

main()
