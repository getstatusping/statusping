import packageJson from '../package.json' with { type: 'json' }
import { MIGRATIONS } from './schema.ts'

/** The release version, kept in one authoritative place: package.json. */
export const APP_VERSION = packageJson.version

/** The highest forward-only database migration bundled with this release. */
export const SCHEMA_VERSION = MIGRATIONS.length
