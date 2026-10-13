/**
 * Own-key lookups for maps keyed by names that come from the configuration, the environment or a
 * request. A plain object answers `map["constructor"]` or `"toString" in map` from
 * Object.prototype, so a monitor, channel or notice named after a prototype member would resolve
 * to a native function. These helpers only ever see the map's own entries.
 */

/** The value stored under `key` itself, never one inherited from the prototype. */
export function own<T>(map: Readonly<Record<string, T>> | null | undefined, key: string): T | undefined {
  return map != null && Object.hasOwn(map, key) ? map[key] : undefined
}

/** Whether `key` is an own entry of `map`. */
export function hasOwn(map: object | null | undefined, key: string): boolean {
  return map != null && Object.hasOwn(map, key)
}

/** An empty map with no prototype, so every key is only ever an own entry. */
export function nullProtoRecord<T>(entries?: Iterable<readonly [string, T]>): Record<string, T> {
  const out = Object.create(null) as Record<string, T>
  if (entries) for (const [key, value] of entries) out[key] = value
  return out
}
