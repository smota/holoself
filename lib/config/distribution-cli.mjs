import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse } from 'yaml'
import {
  defaultDistributionSelection,
  resolveDistribution,
  selectDistributionRoute,
  distributionDrift,
} from './execution-distribution.mjs'
import {
  planDistributionChange,
  applyDistributionChange,
  undoDistributionChange,
} from './distribution-change.mjs'
import {
  resolveQuotaControlPolicy,
  evaluateSeatQuotaControl,
  QUOTA_COVERAGE_DISCLOSURE,
} from './quota-policy.mjs'
import { loadAuthoritativeConfigs } from './authority.mjs'
export function handleDistribution(args, cwd = process.cwd()) {
  const [command, ...rest] = args,
    flag = (name, fallback = null) => {
      const i = rest.indexOf(name)
      return i < 0 ? fallback : rest[i + 1]
    }
  const root = resolve(cwd, flag('--target', '.')),
    loaded = loadAuthoritativeConfigs(root),
    config = loaded.isUnified ? loaded.unified : loaded.workflow
  const selection = config.executionDistribution
  const jsonFile = (name) => JSON.parse(readFileSync(resolve(cwd, flag(name)), 'utf8'))
  let result
  if (command === 'catalog')
    result = {
      selection: defaultDistributionSelection(),
      ...resolveDistribution(defaultDistributionSelection()),
    }
  else if (command === 'plan')
    result = planDistributionChange(
      root,
      flag('--selection') ? jsonFile('--selection') : defaultDistributionSelection(),
    )
  else if (command === 'apply') {
    if (!flag('--plan')) throw new Error('--plan required')
    result = applyDistributionChange(root, jsonFile('--plan'), flag('--confirm'))
  } else if (command === 'undo')
    result = undoDistributionChange(root, flag('--receipt'), flag('--confirm'))
  else if (command === 'inspect') {
    if (!selection)
      throw new Error('No selected distribution; review distribution plan before adopting')
    result = { ...resolveDistribution(selection), observation: 'desired-only', effects: [] }
    if (flag('--availability'))
      result.proposals = Object.keys(result.roles).map((role) =>
        selectDistributionRoute({
          selection,
          role,
          availability: jsonFile('--availability'),
          now: Date.now(),
        }),
      )
  } else if (command === 'quota') {
    const effectiveSelection = selection ?? defaultDistributionSelection()
    const overrides = {}
    if (rest.includes('--enable')) overrides.enabled = true
    if (rest.includes('--disable')) overrides.enabled = false
    const windows = rest.flatMap((token, index) =>
      token === '--window' && typeof rest[index + 1] === 'string'
        ? rest[index + 1]
            .split(',')
            .map((w) => w.trim())
            .filter(Boolean)
        : [],
    )
    if (windows.length > 0) overrides.windows = windows
    if (flag('--threshold')) overrides.thresholdRemainingPct = Number(flag('--threshold'))
    if (flag('--cadence')) overrides.checkpointCadence = flag('--cadence')
    const policy = resolveQuotaControlPolicy(config, overrides)
    const observations = flag('--observations') ? jsonFile('--observations') : []
    const seatArg = flag('--seat')
    const atSafeCheckpoint = !rest.includes('--mid-phase')
    const excludedFamilies = flag('--exclude-families')
      ? flag('--exclude-families')
          .split(',')
          .map((f) => f.trim())
      : []
    const profile = resolveDistribution(effectiveSelection)
    const seats = seatArg ? [seatArg] : Object.keys(profile.roles)
    const evaluations = Object.fromEntries(
      seats.map((seat) => [
        seat,
        evaluateSeatQuotaControl({
          seat,
          policy,
          selection: effectiveSelection,
          observations,
          atSafeCheckpoint,
          excludedFamilies,
          nowMs: Date.now(),
        }),
      ]),
    )
    result = {
      ok: true,
      policy,
      seats: evaluations,
      coverageDisclosure: QUOTA_COVERAGE_DISCLOSURE,
      effects: [],
    }
  } else if (command === 'check') {
    if (!selection || !flag('--rig'))
      throw new Error('Selected distribution and --rig path required')
    const rig = parse(readFileSync(resolve(cwd, flag('--rig')), 'utf8'), { uniqueKeys: true })
    result = distributionDrift({
      selection,
      installed: rig.pods.flatMap((p) =>
        p.members.map((m) => ({
          seat: p.id + '.' + m.id,
          runtime: m.runtime,
          model: m.model,
          effort: m.effort,
        })),
      ),
    })
  } else {
    process.stdout.write(
      'Usage: agentflow-sdlc distribution <catalog|inspect|check|plan|apply|undo|quota> [--target <project>] [--selection <json>] [--plan <json> --confirm <digest>] [--rig <yaml>] [--availability <json>] [--observations <json>] [--seat <role>] [--receipt <path>] [--json]\n',
    )
    return command && command !== '--help' ? 1 : 0
  }
  process.stdout.write(JSON.stringify(result, null, 2) + '\n')
  return result.ok === false ? 1 : 0
}
