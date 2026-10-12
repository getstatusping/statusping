import { readCappedJson } from '../util/capped-body.ts'
import { EXPIRY_LOOKUP_MAX_BYTES, EXPIRY_LOOKUP_TIMEOUT_MS, errorMessage, normalizeHostname, toUnixSeconds, type ExpiryLookup, type ExpiryProviderOptions } from './types.ts'

const IANA_DNS_BOOTSTRAP_URL = 'https://data.iana.org/rdap/dns.json'

interface DnsBootstrap {
  services?: unknown
}

interface RdapDomain {
  events?: unknown
}

function registryUrlFor(hostname: string, bootstrap: DnsBootstrap): string | null {
  if (!Array.isArray(bootstrap.services)) return null
  const labels = hostname.split('.')
  let selected: string | null = null
  let selectedLength = -1
  for (const service of bootstrap.services) {
    if (!Array.isArray(service) || service.length < 2 || !Array.isArray(service[0]) || !Array.isArray(service[1])) continue
    for (const suffix of service[0]) {
      if (typeof suffix !== 'string') continue
      const parts = suffix.toLowerCase().split('.')
      if (parts.length <= selectedLength || parts.length > labels.length) continue
      if (parts.every((part, index) => labels[labels.length - parts.length + index] === part)) {
        const base = service[1].find((url): url is string => typeof url === 'string' && /^https:\/\//i.test(url))
        if (base) {
          selected = base
          selectedLength = parts.length
        }
      }
    }
  }
  return selected
}

function expirationFromDomain(domain: RdapDomain): number | null {
  if (!Array.isArray(domain.events)) return null
  for (const event of domain.events) {
    if (!event || typeof event !== 'object') continue
    const value = event as { eventAction?: unknown; eventDate?: unknown }
    if (typeof value.eventAction === 'string' && value.eventAction.toLowerCase() === 'expiration') {
      const expiration = toUnixSeconds(value.eventDate)
      if (expiration !== null) return expiration
    }
  }
  return null
}

/**
 * Looks up a registered domain's expiration through IANA's DNS RDAP bootstrap.
 * `hostname` should be the registered domain (for example `example.com`), not
 * an arbitrary application subdomain; the caller owns that policy.
 */
export async function lookupDomainExpiry(hostname: string, options: ExpiryProviderOptions): Promise<ExpiryLookup> {
  const domain = normalizeHostname(hostname)
  if (!domain) return { status: 'unavailable', reason: 'invalid domain' }

  let bootstrapResponse: Response
  try {
    bootstrapResponse = await options.fetch(IANA_DNS_BOOTSTRAP_URL, { headers: { accept: 'application/rdap+json, application/json' }, signal: AbortSignal.timeout(EXPIRY_LOOKUP_TIMEOUT_MS) })
  } catch (error) {
    return { status: 'unknown', error: `IANA RDAP bootstrap request failed: ${errorMessage(error)}` }
  }
  if (!bootstrapResponse.ok) return { status: 'unknown', error: `IANA RDAP bootstrap returned HTTP ${bootstrapResponse.status}` }

  let bootstrap: DnsBootstrap
  try {
    bootstrap = (await readCappedJson(bootstrapResponse, EXPIRY_LOOKUP_MAX_BYTES)) as DnsBootstrap
  } catch (error) {
    return { status: 'unknown', error: `IANA RDAP bootstrap returned invalid JSON: ${errorMessage(error)}` }
  }
  const registry = registryUrlFor(domain, bootstrap)
  if (!registry) return { status: 'unavailable', reason: 'no RDAP registry is listed for this domain suffix' }

  let response: Response
  try {
    response = await options.fetch(`${registry.replace(/\/$/, '')}/domain/${encodeURIComponent(domain)}`, {
      headers: { accept: 'application/rdap+json, application/json' },
      signal: AbortSignal.timeout(EXPIRY_LOOKUP_TIMEOUT_MS),
    })
  } catch (error) {
    return { status: 'unknown', error: `RDAP registry request failed: ${errorMessage(error)}` }
  }
  if (response.status === 404 || response.status === 405 || response.status === 501) {
    return { status: 'unavailable', reason: `RDAP registry returned HTTP ${response.status}` }
  }
  if (!response.ok) return { status: 'unknown', error: `RDAP registry returned HTTP ${response.status}` }

  let domainRecord: RdapDomain
  try {
    domainRecord = (await readCappedJson(response, EXPIRY_LOOKUP_MAX_BYTES)) as RdapDomain
  } catch (error) {
    return { status: 'unknown', error: `RDAP registry returned invalid JSON: ${errorMessage(error)}` }
  }
  const expiresAt = expirationFromDomain(domainRecord)
  return expiresAt === null
    ? { status: 'unknown', error: 'RDAP registry did not provide an expiration event' }
    : { status: 'expiration', expiresAt }
}
