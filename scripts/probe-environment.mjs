import { probeEnvironment } from '../lib/environment.mjs'
const args = process.argv.slice(2)
const value = (flag) => args[args.indexOf(flag) + 1]
try {
  const report = await probeEnvironment(value('--target') ?? process.cwd(), {
    profile: value('--probe'),
    authorize: async ({ probe }) =>
      args.includes('--execute') && probe.effect !== 'external-mutation',
  })
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  process.exitCode = report.readiness === 'blocked' ? 3 : 0
} catch (error) {
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 2
}
