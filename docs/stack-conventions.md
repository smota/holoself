---
name: Stack conventions template
---

<!--
Copy this file to `docs/stack-conventions.md` in the consuming project and fill in every
section. Role-persona skills and this framework's engines (ensure-workflow-artifacts.mjs,
validate-bounded.mjs) point here for domain checklists instead of hardcoding them, so this file —
not the framework — is where a project's actual stack rules live.
-->

# Stack Conventions

## Tech stack (locked)

<!-- Language, package manager, frameworks, database, auth, styling, test runners, CI/CD, runtime -->

## Sensitive surfaces (for bounded-work classification)

<!-- List the path fragments, prefixes, and code patterns that should never be treated as
low-risk/bounded work in this project: auth, tenant isolation, billing, schema/migrations,
secrets, production permissions, or anything else with wide blast radius. Mirror this list into
`agent-workflow.config.json`'s `bounded` section so `validate-bounded.mjs` enforces it. -->

## Domain checklist — Analyst

<!-- What must every spec/acceptance-criteria pass check for this project specifically? -->

## Domain checklist — Architect

<!-- Required architectural patterns, ADR triggers, and conventions specific to this stack -->

## Domain checklist — Developer

<!-- Required implementation patterns: validation boundaries, auth/session patterns, data-access
rules, error handling, naming conventions -->

## Domain checklist — Tester

<!-- Mandatory test categories for this project (e.g. tenant isolation, billing, localization),
file naming conventions, coverage thresholds -->

## Domain checklist - Technical writer

<!-- Where user docs and screenshots live, and any localization/format requirements -->

## Domain checklist — DevOps

<!-- Deployment targets, infrastructure-as-code location, secrets management, CI/CD specifics -->
