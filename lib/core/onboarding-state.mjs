export const SCHEMA_VERSION = 1
export const MAX_STRING_LENGTH = 2048
export const MAX_ARRAY_ITEMS = 100

export const CAPABILITY_CLI = 'agentflow-cli'
export const CAPABILITY_SKILLS = 'agentflow-skills'
export const REQUIRED_CAPABILITIES = Object.freeze([CAPABILITY_CLI, CAPABILITY_SKILLS])

export const PRESENCE_VALUES = Object.freeze(['available', 'missing', 'unknown'])
export const COMPATIBILITY_VALUES = Object.freeze(['compatible', 'incompatible', 'unknown'])
export const OPERATION_OUTCOME_VALUES = Object.freeze([
  'succeeded',
  'failed',
  'unknown',
  'not-requested',
])
export const UPDATE_DISPOSITION_VALUES = Object.freeze([
  'available',
  'current',
  'deferred',
  'unknown',
])
export const EVIDENCE_TYPE_VALUES = Object.freeze([
  'declared',
  'observed',
  'unavailable',
  'unknown',
])

export function isBoundedString(val) {
  return typeof val === 'string' && val.trim().length > 0 && val.length <= MAX_STRING_LENGTH
}

function assessComponentReuse(component) {
  const reasons = []
  if (!component || typeof component !== 'object') {
    return { reusable: false, reasons: ['Component is not a valid object'] }
  }
  if (component.presence !== 'available') {
    reasons.push(`Presence is "${component.presence}", expected "available"`)
  }
  if (component.compatibility !== 'compatible') {
    reasons.push(`Compatibility is "${component.compatibility}", expected "compatible"`)
  }
  if (component.evidence !== 'observed') {
    reasons.push(`Evidence type is "${component.evidence}", expected "observed"`)
  }
  if (!isBoundedString(component.provenance)) {
    reasons.push('Observed evidence lacks valid bounded string provenance')
  }
  if (
    component.operationOutcome !== 'succeeded' &&
    component.operationOutcome !== 'not-requested'
  ) {
    reasons.push(
      `Operation outcome is "${component.operationOutcome}", expected succeeded or not-requested`,
    )
  }
  if (
    (component.id === CAPABILITY_SKILLS || component.kind === 'skills') &&
    component.hostDiscovered !== true
  ) {
    reasons.push('Skills host discovery is false or unverified')
  }
  return { reusable: reasons.length === 0, reasons }
}

export function normalizeComponent(rawComp, index = 0, errors = [], unknowns = []) {
  if (!rawComp || typeof rawComp !== 'object') {
    errors.push(`Component at index ${index} must be an object`)
    return null
  }

  let id = typeof rawComp.id === 'string' ? rawComp.id.trim() : ''
  if (!id || id.length > MAX_STRING_LENGTH) {
    errors.push(`Component at index ${index} has missing or out-of-bounds id`)
    id = id ? id.slice(0, MAX_STRING_LENGTH) : `unknown-${index}`
  }

  const presence = PRESENCE_VALUES.includes(rawComp.presence) ? rawComp.presence : 'unknown'
  if (rawComp.presence !== undefined && !PRESENCE_VALUES.includes(rawComp.presence)) {
    unknowns.push({
      componentId: id,
      field: 'presence',
      reason: `Invalid presence "${rawComp.presence}"`,
    })
  }

  const compatibility = COMPATIBILITY_VALUES.includes(rawComp.compatibility)
    ? rawComp.compatibility
    : 'unknown'
  if (
    rawComp.compatibility !== undefined &&
    !COMPATIBILITY_VALUES.includes(rawComp.compatibility)
  ) {
    unknowns.push({
      componentId: id,
      field: 'compatibility',
      reason: `Invalid compatibility "${rawComp.compatibility}"`,
    })
  }

  const operationOutcome = OPERATION_OUTCOME_VALUES.includes(rawComp.operationOutcome)
    ? rawComp.operationOutcome
    : 'unknown'
  if (
    rawComp.operationOutcome !== undefined &&
    !OPERATION_OUTCOME_VALUES.includes(rawComp.operationOutcome)
  ) {
    unknowns.push({
      componentId: id,
      field: 'operationOutcome',
      reason: `Invalid operationOutcome "${rawComp.operationOutcome}"`,
    })
  }

  const evidence = EVIDENCE_TYPE_VALUES.includes(rawComp.evidence) ? rawComp.evidence : 'unknown'
  if (rawComp.evidence !== undefined && !EVIDENCE_TYPE_VALUES.includes(rawComp.evidence)) {
    unknowns.push({
      componentId: id,
      field: 'evidence',
      reason: `Invalid evidence "${rawComp.evidence}"`,
    })
  }

  let provenance
  if (rawComp.provenance !== undefined) {
    if (isBoundedString(rawComp.provenance)) {
      provenance = rawComp.provenance
    } else {
      errors.push(`Component "${id}" provenance must be a bounded non-empty string`)
    }
  }
  if (evidence === 'observed' && !provenance) {
    errors.push(`Component "${id}" has observed evidence but lacks valid provenance`)
  }

  const updateEvidence = EVIDENCE_TYPE_VALUES.includes(rawComp.updateEvidence)
    ? rawComp.updateEvidence
    : undefined
  const updateProvenance = isBoundedString(rawComp.updateProvenance)
    ? rawComp.updateProvenance
    : undefined
  const availableVersion = isBoundedString(rawComp.availableVersion)
    ? rawComp.availableVersion
    : undefined

  let updateDisposition = UPDATE_DISPOSITION_VALUES.includes(rawComp.updateDisposition)
    ? rawComp.updateDisposition
    : 'unknown'
  if (
    rawComp.updateDisposition !== undefined &&
    !UPDATE_DISPOSITION_VALUES.includes(rawComp.updateDisposition)
  ) {
    unknowns.push({
      componentId: id,
      field: 'updateDisposition',
      reason: `Invalid updateDisposition "${rawComp.updateDisposition}"`,
    })
  }

  const hasVerifiedRelease = updateEvidence === 'observed' && Boolean(updateProvenance)
  if (updateDisposition === 'available') {
    if (!hasVerifiedRelease || !availableVersion) {
      unknowns.push({
        componentId: id,
        field: 'updateDisposition',
        reason:
          'Unverified "available" updateDisposition requires updateEvidence="observed", updateProvenance, and availableVersion; normalized to "unknown"',
      })
      updateDisposition = 'unknown'
    }
  } else if (updateDisposition === 'current') {
    if (!hasVerifiedRelease) {
      unknowns.push({
        componentId: id,
        field: 'updateDisposition',
        reason:
          'Unverified "current" updateDisposition requires updateEvidence="observed" and updateProvenance; normalized to "unknown"',
      })
      updateDisposition = 'unknown'
    }
  }

  let hostDiscovered
  if (rawComp.hostDiscovered !== undefined) {
    hostDiscovered = rawComp.hostDiscovered === true
  }
  if ((id === CAPABILITY_SKILLS || rawComp.kind === 'skills') && hostDiscovered !== true) {
    hostDiscovered = false
    unknowns.push({
      componentId: id,
      field: 'hostDiscovered',
      reason: 'Skills host discovery is false or unverified',
    })
  }

  const normalized = {
    id,
    presence,
    compatibility,
    operationOutcome,
    updateDisposition,
    evidence,
  }

  if (isBoundedString(rawComp.version)) normalized.version = rawComp.version
  if (provenance) normalized.provenance = provenance
  if (hostDiscovered !== undefined) normalized.hostDiscovered = hostDiscovered
  if (updateEvidence) normalized.updateEvidence = updateEvidence
  if (updateProvenance) normalized.updateProvenance = updateProvenance
  if (availableVersion) normalized.availableVersion = availableVersion

  return normalized
}

export function evaluateRuntimePolicy({
  request,
  normalizedComponents,
  errors = [],
  unknowns = [],
}) {
  const proposals = []
  const assessedComponents = [...normalizedComponents]
  const foundMap = new Map()

  for (const comp of assessedComponents) {
    foundMap.set(comp.id, comp)
  }

  for (const reqCap of REQUIRED_CAPABILITIES) {
    if (!foundMap.has(reqCap)) {
      const unknownComp = {
        id: reqCap,
        presence: 'unknown',
        compatibility: 'unknown',
        operationOutcome: 'not-requested',
        updateDisposition: 'unknown',
        evidence: 'unknown',
      }
      assessedComponents.push(unknownComp)
      foundMap.set(reqCap, unknownComp)
      unknowns.push({
        componentId: reqCap,
        field: 'presence',
        reason: `Required capability "${reqCap}" was missing from runtime evidence (status unknown)`,
      })
    }
  }

  let allRequiredReusable = true
  let hasUnknownOutcome = false
  let hasInstallNeeded = false
  let hasUpgradeNeeded = false

  for (const comp of assessedComponents) {
    const isRequired = REQUIRED_CAPABILITIES.includes(comp.id)
    const reuseResult = assessComponentReuse(comp)

    if (isRequired && !reuseResult.reusable) {
      allRequiredReusable = false
    }

    if (comp.operationOutcome === 'unknown') {
      hasUnknownOutcome = true
      unknowns.push({
        componentId: comp.id,
        field: 'operationOutcome',
        reason: `Ambiguous external outcome for component "${comp.id}" requires reconciliation before retry`,
      })
      continue
    }

    if (comp.presence === 'missing' && comp.evidence === 'observed') {
      hasInstallNeeded = true
      proposals.push({
        type: 'install',
        componentId: comp.id,
        runtimeId: request.runtimeId,
        description: `Install missing capability "${comp.id}" via runtime-managed installation`,
      })
    } else if (comp.compatibility === 'incompatible' && comp.evidence === 'observed') {
      hasUpgradeNeeded = true
      proposals.push({
        type: 'upgrade',
        componentId: comp.id,
        runtimeId: request.runtimeId,
        description: `Incompatible version detected for "${comp.id}"; upgrade required`,
      })
    } else if (comp.updateDisposition === 'available') {
      proposals.push({
        type: 'update',
        componentId: comp.id,
        runtimeId: request.runtimeId,
        shared: Boolean(request.sharedUpdate),
        description: `Verified newer release available for "${comp.id}"`,
      })
    } else if (comp.updateDisposition === 'deferred') {
      proposals.push({
        type: 'deferred-update',
        componentId: comp.id,
        runtimeId: request.runtimeId,
        description: `Compatible version retained for "${comp.id}"; update deferred`,
      })
    }
  }

  const uniqueUnknowns = []
  const seenUnknownKeys = new Set()
  for (const u of unknowns) {
    const key = `${u.componentId}:${u.field}:${u.reason}`
    if (!seenUnknownKeys.has(key)) {
      seenUnknownKeys.add(key)
      uniqueUnknowns.push(u)
    }
  }

  const runtimeReady = errors.length === 0 && allRequiredReusable && !hasUnknownOutcome
  let action = 'ready'
  if (errors.length > 0 || hasUnknownOutcome) {
    action = 'reconcile'
  } else if (!runtimeReady) {
    if (hasInstallNeeded) {
      action = 'install'
    } else if (hasUpgradeNeeded) {
      action = 'upgrade'
    } else {
      action = 'reconcile'
    }
  }

  return {
    runtimeReady,
    action,
    components: assessedComponents.filter((c) => REQUIRED_CAPABILITIES.includes(c.id)),
    proposals:
      errors.length > 0
        ? []
        : proposals
            .slice(0, MAX_ARRAY_ITEMS)
            .map((p) => ({ ...p, description: p.description.slice(0, MAX_STRING_LENGTH) })),
    unknowns: uniqueUnknowns
      .slice(0, MAX_ARRAY_ITEMS)
      .map((u) => ({ ...u, reason: u.reason.slice(0, MAX_STRING_LENGTH) })),
    errors: errors.slice(0, MAX_ARRAY_ITEMS),
  }
}
