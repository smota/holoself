# Delivery release acceptance

This is the release gate for the Agentflow 2.0 delivery improvements. It is not a claim that a release has shipped.

## Deterministic gate

Run `pnpm validate:release`. The existing CI matrix executes it on Windows, Ubuntu and macOS with Node 20 and 24. New tests cover denied authorization, changed criteria, stale writer generations, recovery source races, unknown external operations, stale reports, actual JUnit collection, contained receipts, hard-interruption rollback, profile dependency closure and consumer CLI behavior.

Add no passing release receipt for a job that was only configured. Record exact source revision, package digest, platform/runtime, command, assertion outcome and failure details. Local green remains distinct from remote CI and installed-package acceptance.

## Required RC exercises

| Exercise                         | Required evidence                                                                                                                       |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Fresh Windows and Linux consumer | Actual packed package, contained adoption, bounded feature, observed tests and accepted transition                                      |
| Existing supported consumer      | Preserved authored files, interrupted upgrade recovery and exact rollback                                                               |
| Legacy demo                      | Explicit fresh-adoption plan; application/history preserved; retired installation identified                                            |
| Durable GitHub run               | Dedicated authorized repository, initialized baseline, permissions/rules/workflow review, competing updates, successful read-back       |
| Executor replacement             | Source checkpoint, stopped prior writer, reconciled uncertain action, new generation, no duplicate effect                               |
| Hosted demo                      | Exact deployed candidate and essential journey, local server stopped; failed deployment and exercised rollback in an authorized fixture |
| High-assurance change            | Actual human security and acceptance review on the open PR, bound to its candidate                                                      |
| Supported provider mode          | Three live trials per claimed mode, one single-agent baseline and one bounded advisory case; failures and unknown usage retained        |

Three trials provide a reproducibility check, not a statistical reliability estimate. Establish performance thresholds before evaluating the RC. Record completion rate, first valid evidence, retries by cause, recovery duration, interventions, escaped defects and available usage, with denominators and unknowns.

## Publication gates

Issue/PR publication, merge, npm release, tags and site deployment remain separately authorized actions. Verify the exact approved commit/version/destination, remote CI, package contents, registry metadata and hosted behavior independently. The product site must not advertise unexecuted live conformance or an unpublished npm 2.0 release.
