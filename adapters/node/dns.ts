import { lookup } from 'node:dns/promises'
import type { HostResolver } from '../../src/util/private-targets.ts'

/** Every address a hostname resolves to, for the private-target guard (STATUSPING_BLOCK_PRIVATE_TARGETS). */
export const nodeResolveHost: HostResolver = async (hostname) =>
  (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address)
