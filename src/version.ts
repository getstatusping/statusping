import packageJson from '../package.json' with { type: 'json' }

/** The release version, kept in one authoritative place: package.json. */
export const APP_VERSION = packageJson.version
