/** Writes statusping.schema.json from the config types (see src/admin/config-schema.ts). */
import { writeFile } from 'node:fs/promises'
import { configSchemaJson } from '../src/admin/config-schema.ts'

await writeFile(new URL('../statusping.schema.json', import.meta.url), configSchemaJson())
process.stdout.write('statusping.schema.json written\n')
