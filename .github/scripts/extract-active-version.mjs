import { readFile } from 'node:fs/promises'

const deployment = JSON.parse(await readFile(process.argv[2], 'utf8'))
const versions = Array.isArray(deployment?.versions) ? deployment.versions : []
const stable = versions.filter((entry) => entry?.percentage === 100)
if (
    stable.length !== 1
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        stable[0].version_id || '',
    )
) {
    throw new Error('Production must have exactly one valid version receiving 100% traffic before deployment')
}
process.stdout.write(stable[0].version_id)
