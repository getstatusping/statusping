/** Timezone pickers for setup and Settings, from the runtime's IANA database. */
const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

let cached: string[] | undefined

/** Every IANA zone the runtime knows, with UTC first. */
export function timezones(): string[] {
  if (!cached) {
    const all = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : []
    cached = ['UTC', ...all.filter((zone) => zone !== 'UTC')]
  }
  return cached
}

/** A <select> of timezones; a saved value the runtime does not list is kept as an option. */
export function timezoneSelect(name: string, current: string, attrs = ''): string {
  const zones = timezones()
  const options = zones.includes(current) || !current ? zones : [current, ...zones]
  return `<select class="input" id="${escape(name)}" name="${escape(name)}" ${attrs}>${options.map((zone) => `<option value="${escape(zone)}"${zone === current ? ' selected' : ''}>${escape(zone.replace(/_/g, ' '))}</option>`).join('')}</select>`
}
