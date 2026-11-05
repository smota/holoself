// Synthetic self-root corpus and fixture builder for retrieval evaluation (issue #67).
// All persona details (Alexia V. Moreira, Aethelgard Cloud, Meridian, Zephyr FinTech) are fictional.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, realpathSync } from 'node:fs'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { run } from '../../../src/cli.mjs'

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url))
export const HOLOSELF_BIN = join(REPO_ROOT, 'bin', 'holoself.mjs')
export const FIXED_MTIME = new Date('2025-01-15T12:00:00.000Z')

const ALL_LENSES = ['general', 'professional', 'public-voice', 'technical', 'leadership', 'interview', 'private']
const LINKED_SECONDARY_LENSES = ['professional', 'public-voice', 'technical', 'leadership', 'interview']

function frontmatterBlock(fields) {
  const lines = ['---']
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue
    if (Array.isArray(value)) {
      lines.push(`${key}: [${value.join(', ')}]`)
    } else if (typeof value === 'object') {
      lines.push(`${key}:`)
      for (const [subKey, subVal] of Object.entries(value)) {
        lines.push(`  ${subKey}: ${subVal}`)
      }
    } else {
      lines.push(`${key}: ${value}`)
    }
  }
  lines.push('---', '')
  return lines.join('\n')
}

function padSection(heading, paragraphs) {
  return `## ${heading}\n\n${paragraphs.join('\n\n')}\n`
}

export const SYNTHETIC_DOCUMENTS = Object.freeze([
  // ---------------------------------------------------------------------------
  // profile/ (8 documents)
  // ---------------------------------------------------------------------------
  {
    path: 'profile/identity.md',
    frontmatter: {
      access_lenses: ALL_LENSES,
      disclosure: 'internal-only',
      sensitivity: 'personal',
      document_role: 'content'
    },
    body: [
      '# Identity',
      '',
      'I am Alexia V. Moreira, a Principal Distributed Systems Engineer at Aethelgard Cloud based in Lisbon.',
      'My work centers on consensus storage engines, deterministic simulation, and calm technical stewardship across platform teams.',
      '',
      padSection('Core Identity and Background', [
        'Over twelve years in infrastructure engineering, I have focused on building fault-tolerant storage layers that remain predictable under network partitions and hardware degradation.',
        'I value small, verifiable increments, explicit invariant checks, and clear operational ownership over complex architectural ceremonies. #identity #distributed-systems'
      ]),
      padSection('Operating Stance', [
        'When collaborating across engineering and product groups, I anchor discussions in concrete failure modes, measurable latency budgets, and reproducible benchmarks.',
        'Minha identidade técnica valoriza clareza, autonomia responsável, transparência e decisões fundamentadas em evidências observáveis em produção.'
      ])
    ].join('\n')
  },
  {
    path: 'profile/preferences.md',
    frontmatter: {
      access_lenses: ALL_LENSES,
      disclosure: 'internal-only',
      sensitivity: 'personal',
      document_role: 'policy'
    },
    body: [
      '# Collaboration and AI Preferences',
      '',
      'Describe how I prefer to collaborate with engineers and AI coding assistants across day-to-day workflows.',
      '',
      padSection('Documentation and Code Style Preferences', [
        'Keep README introductions, architecture notes, and pull-request descriptions concise, structured with explicit trade-off tables, and free of marketing superlatives.',
        'Prefer small, reviewable diffs with deterministic tests before any structural refactoring. Never introduce speculative configuration layers or unused wrapper abstractions. #preferences #collaboration'
      ]),
      padSection('Working Rhythm and Feedback Norms', [
        'Start technical proposals with the problem statement, non-goals, and falsifiable invariants before listing implementation steps.',
        'Em revisões de código e documentação, prefiro comentários diretos com exemplos concretos e critérios claros de aceitação.'
      ])
    ].join('\n')
  },
  {
    path: 'profile/voice.md',
    frontmatter: {
      access_lenses: ALL_LENSES,
      disclosure: 'internal-only',
      sensitivity: 'personal',
      document_role: 'policy'
    },
    body: [
      '# Personal Writing Voice and Editorial Tone',
      '',
      'Guidelines for my personal writing voice across technical essays, keynote abstracts, and internal engineering memos.',
      '',
      padSection('Sentence Structure and Tone', [
        'Write in direct, active prose that respects the reader time. Open with the concrete conclusion or operational lesson before unpacking the historical narrative.',
        'Replace vague intensifiers with measured numbers, p99 latency figures, or explicit failure boundaries. Maintain a calm, candid, and unhurried editorial cadence. #voice #writing'
      ]),
      padSection('Bilingual Expression (EN / PT)', [
        'In both English and Portuguese, preserve precise systems terminology rather than awkward literal translations, while keeping sentences crisp and natural.',
        'No nosso estilo editorial para artigos técnicos e apresentações, priorize frases diretas, voz ativa e exemplos reais de engenharia.'
      ])
    ].join('\n')
  },
  {
    path: 'profile/thinking.md',
    frontmatter: {
      access_lenses: ALL_LENSES,
      disclosure: 'internal-only',
      sensitivity: 'personal',
      document_role: 'policy'
    },
    body: [
      '# Reasoning and Decision-Making Models',
      '',
      'How I decompose ambiguous technical problems, evaluate irreversible trade-offs, and stress-test assumptions.',
      '',
      padSection('First-Principles Decomposition', [
        'Separate durable state invariants from transient execution mechanics. Before debating an implementation pattern, write down what must never become corrupted or leaked.',
        'Distinguish two-way doors (reversible module boundaries, internal APIs) from one-way doors (public wire formats, on-disk storage schemas, security guarantees). #thinking #decisions'
      ]),
      padSection('Pre-Mortem Discipline', [
        'For every high-stakes migration, run a fifteen-minute pre-mortem asking which silent data anomaly or clock skew scenario would invalidate our rollback plan.',
        'Questionamentos estruturados reduzem o viés de confirmação antes de comprometer recursos da plataforma.'
      ])
    ].join('\n')
  },
  {
    path: 'profile/work-context.md',
    frontmatter: {
      access_lenses: ALL_LENSES,
      disclosure: 'internal-only',
      sensitivity: 'personal',
      document_role: 'content'
    },
    body: [
      '# Current Work Context and Q4 Priorities',
      '',
      'Active Q4 Meridian storage priorities, quarterly sprint goals, and platform delivery focus at Aethelgard Cloud.',
      '',
      padSection('Q4 Meridian Priorities and Sprint Goals', [
        'Primary Q4 priority is completing the Meridian multi-region Raft log compaction rollout and cutting p99 cross-AZ replication tail latency below 14 milliseconds.',
        'Secondary sprint goals for Q2 and Q4 storage milestones include stabilizing the Borealis read-replica proxy and auditing zero-downtime snapshot transfers. #meridian #priorities'
      ]),
      padSection('Stakeholder Commitments', [
        'Weekly architecture sync with the storage leads every Tuesday morning, plus biweekly reliability reviews with the infrastructure VP.',
        'O foco atual prioriza estabilidade operacional e redução de latência na camada de consenso Meridian.'
      ])
    ].join('\n')
  },
  {
    path: 'profile/change.md',
    frontmatter: {
      access_lenses: ALL_LENSES,
      disclosure: 'internal-only',
      sensitivity: 'personal',
      document_role: 'policy'
    },
    body: [
      '# Personal Change Compass',
      '',
      'Habits I am actively cultivating and anti-patterns I am retiring in my day-to-day leadership practice.',
      '',
      padSection('Delegating Subsystem Ownership', [
        'Step back from writing every critical patch personally during storage escalations; instead, pair with senior engineers so they build first-hand diagnostic fluency.',
        'Protect two uninterrupted four-hour deep-work blocks every week for long-horizon architecture design and formal specification review. #change #growth'
      ]),
      padSection('Sustainable Pace', [
        'Decline low-leverage status meetings that lack a written agenda or decision owner, redirecting updates to asynchronous RFC threads.',
        'Manter limites sustentáveis evita sobrecarga e fortalece a autonomia técnica de toda a equipe.'
      ])
    ].join('\n')
  },
  {
    path: 'profile/values-pt.md',
    frontmatter: {
      access_lenses: ALL_LENSES,
      disclosure: 'internal-only',
      sensitivity: 'personal',
      document_role: 'content'
    },
    body: [
      '# Valores Fundamentais de Trabalho e Ética Profissional',
      '',
      'Princípios que guiam minha identidade profissional, autonomia responsável e transparência radical na engenharia.',
      '',
      padSection('Autonomia e Transparência', [
        'Meus valores fundamentais combinam autonomia responsável com transparência radical na comunicação de riscos técnicos, prazos e incidentes operacionais.',
        'Acredito que equipes de alta confiança prosperam quando erros de projeto são analisados sem culpa e transformados em melhorias determinísticas no sistema. #valores #identidade'
      ]),
      padSection('Sustentabilidade e Rigor', [
        'Rejeito atalhos que comprometam a privacidade do usuário ou a integridade dos dados em troca de velocidade aparente no curto prazo.',
        'A excelência técnica exige simplicidade deliberada, respeito ao tempo dos colegas e documentação honesta das limitações conhecidas.'
      ])
    ].join('\n')
  },
  {
    path: 'profile/communication-style.md',
    frontmatter: {
      access_lenses: ALL_LENSES,
      disclosure: 'internal-only',
      sensitivity: 'personal',
      document_role: 'content'
    },
    body: [
      '# Asynchronous Communication and RFC Habits',
      '',
      'How I structure written engineering updates, executive summaries, and cross-team design discussions.',
      '',
      padSection('Written Briefs Over Ad-Hoc Calls', [
        'Before scheduling a cross-team alignment call, circulate a one-page narrative memo stating the context, three viable options, and the recommended path.',
        'In executive briefings, lead with the operational health indicator, customer impact, and resource trade-off within the first four sentences. #communication #rfc'
      ]),
      padSection('Thread Hygiene', [
        'Close resolved design threads with an explicit decision summary and link the resulting commit or ADR so late readers do not re-litigate settled questions.',
        'Comunicação assíncrona bem estruturada preserva o foco profundo de equipes distribuídas em múltiplos fusos horários.'
      ])
    ].join('\n')
  },

  // ---------------------------------------------------------------------------
  // context/ — Policy documents (5 documents, score += 2 baseline)
  // ---------------------------------------------------------------------------
  {
    path: 'context/publishing.md',
    frontmatter: {
      access_lenses: ['general', 'public-voice', 'private'],
      disclosure: 'publish-approved',
      sensitivity: 'personal',
      document_role: 'policy'
    },
    body: [
      '# Public Publishing and Conference Keynote Policy',
      '',
      'Governing rules for conference keynote abstracts, technical blog essays, and public-voice external publications.',
      '',
      padSection('Audience Safety and Anonymization', [
        'Every keynote abstract, conference talk, or blog post must anonymize internal cluster names, customer topologies, and unpublished SLA figures before external sharing.',
        'Focus public essays on reproducible distributed systems lessons, state-machine testing techniques, and open-source architectural patterns. #publishing #keynote'
      ]),
      padSection('Editorial Checklist for Public Essays', [
        'Verify that code listings run without proprietary dependencies and that benchmarks state hardware and workload assumptions explicitly.',
        'Nos artigos para o blog de engenharia, mantenha nosso estilo editorial claro, sem expor métricas confidenciais de clientes.'
      ])
    ].join('\n')
  },
  {
    path: 'context/engineering-principles.md',
    frontmatter: {
      access_lenses: ALL_LENSES,
      disclosure: 'internal-only',
      sensitivity: 'personal',
      document_role: 'policy'
    },
    body: [
      '# Systems Engineering Charter and Invariants',
      '',
      'Mandatory engineering principles for storage services, bounded queues, and fail-closed security gates.',
      '',
      padSection('Bounded Resources and Explicit Backpressure', [
        'Every network queue, batch buffer, and memory cache must enforce an explicit upper bound and reject excess load with deterministic backpressure.',
        'Silent data truncation or unbounded retry storms are treated as severity-one design defects during architecture review. #principles #backpressure'
      ]),
      padSection('Observability and Determinism', [
        'Emit structured trace receipts at storage boundary transitions so tail-latency regressions can be localized without attaching live debuggers.',
        'Sistemas críticos devem falhar de maneira fechada e previsível quando invariantes de segurança não puderem ser verificados.'
      ])
    ].join('\n')
  },
  {
    path: 'context/review-charter.md',
    frontmatter: {
      access_lenses: ALL_LENSES,
      disclosure: 'internal-only',
      sensitivity: 'personal',
      document_role: 'policy'
    },
    body: [
      '# Code and Architecture Review Charter',
      '',
      'Standards for reviewing pull requests, protocol migrations, and storage schema changes.',
      '',
      padSection('Review Turnaround and Depth', [
        'Prioritize reviewing blocking storage diffs within four business hours. Evaluate correctness, failure recovery, and rollback safety before commenting on naming.',
        'Require deterministic regression tests for every concurrency bug fix or protocol edge case before approving the merge. #review #quality'
      ]),
      padSection('Constructive Critique', [
        'Phrase review feedback as testable questions or concrete counterexamples rather than subjective stylistic mandates.',
        'Revisões rigorosas elevam a barra técnica quando combinam empatia com verificação objetiva de invariantes.'
      ])
    ].join('\n')
  },
  {
    path: 'context/communication-charter.md',
    frontmatter: {
      access_lenses: ALL_LENSES,
      disclosure: 'internal-only',
      sensitivity: 'personal',
      document_role: 'policy'
    },
    body: [
      '# Cross-Team Communication Charter',
      '',
      'Policy for written status reports, incident advisories, and architecture decision records.',
      '',
      padSection('Clarity and Provenance', [
        'Every architectural recommendation must cite the benchmark artifact, production trace, or incident report that motivates the change.',
        'Keep stakeholder updates factual, separating verified measurements from unconfirmed hypotheses. #charter #provenance'
      ]),
      padSection('Multilingual Team Alignment', [
        'Ensure core architectural decisions are recorded in accessible Markdown so engineers across Lisbon, Dublin, and São Paulo share a single source of truth.',
        'Documentação clara e rastreável evita alinhamentos verbais frágeis entre equipes distribuídas.'
      ])
    ].join('\n')
  },
  {
    path: 'context/security-posture.md',
    frontmatter: {
      access_lenses: ALL_LENSES,
      disclosure: 'internal-only',
      sensitivity: 'personal',
      document_role: 'policy'
    },
    body: [
      '# Security Posture and Trust Boundaries',
      '',
      'Baseline security rules for local-first tooling, credential isolation, and least-privilege access.',
      '',
      padSection('Zero-Trust Authorization Gates', [
        'Apply authorization and sensitivity filters before ranking or formatting any data record. Never rely on downstream presentation layers to redact restricted fields.',
        'Pin external runtime tools by cryptographic digest and refuse symlink traversal across trust boundaries. #security #zero-trust'
      ]),
      padSection('Secret Hygiene', [
        'Never log bearer tokens, signing keys, or private filesystem paths in diagnostic output or error payloads.',
        'Controles de acesso devem operar em modo fail-closed diante de metadados ausentes ou corrompidos.'
      ])
    ].join('\n')
  },

  // ---------------------------------------------------------------------------
  // context/ — Core domain & bilingual documents (18 documents)
  // ---------------------------------------------------------------------------
  {
    path: 'context/projects.md',
    frontmatter: {
      access_lenses: ['general', 'professional', 'technical', 'leadership', 'private'],
      disclosure: 'internal-only',
      sensitivity: 'personal',
      document_role: 'content'
    },
    body: [
      '# Active Engineering Projects',
      '',
      'Overview of the Meridian consensus engine, Borealis replication proxy, and Horologium deterministic simulator.',
      '',
      padSection('Meridian Consensus Engine', [
        'Meridian is our multi-region Raft storage engine written in Rust and orchestrated via Node.js control planes, serving twelve million transactional writes per minute.',
        'Current work focuses on segmented log compaction, leader lease verification, and snapshot streaming across availability zones. #meridian #projects'
      ]),
      padSection('Borealis and Horologium', [
        'Borealis routes read-consistent queries to nearest follower replicas, while Horologium simulates network partitions and packet reordering deterministically.',
        'Estes três projetos formam a base da plataforma de armazenamento distribuído na Aethelgard Cloud.'
      ])
    ].join('\n')
  },
  {
    path: 'context/decisions.md',
    frontmatter: {
      access_lenses: ['general', 'professional', 'technical', 'leadership', 'private'],
      disclosure: 'internal-only',
      sensitivity: 'personal',
      document_role: 'content',
      supersedes: ['history/2022-monolith-architecture.md']
    },
    body: [
      '# Key Architecture Decisions',
      '',
      'Canonical record of Meridian Raft consensus architecture decisions, storage invariants, and runtime boundaries.',
      '',
      padSection('ADR-014: Meridian Raft Consensus Over Legacy Monolith', [
        'We replaced the 2022 synchronous REST monolith with the Meridian Raft consensus architecture to guarantee linearizable quorum writes across three availability zones.',
        'Leader leases use monotonic hardware clock bounds to prevent stale reads during asymmetric network partitions. #raft #consensus #decisions'
      ]),
      padSection('ADR-019: Zero-Dependency Control Tooling', [
        'All local diagnostic and evaluation CLI tooling uses standard Node.js ESM modules with zero third-party npm dependencies to eliminate supply-chain drift.',
        'Decisões arquiteturais priorizam determinismo, simplicidade operacional e isolamento explícito de falhas.'
      ])
    ].join('\n')
  },
  {
    path: 'context/story-bank.md',
    frontmatter: {
      access_lenses: ['general', 'professional', 'public-voice', 'leadership', 'interview', 'private'],
      disclosure: 'review-required',
      sensitivity: 'personal',
      document_role: 'evidence',
      confidence: 'confirmed'
    },
    body: [
      '# Interview Story Bank and STAR Evidence',
      '',
      'Verified STAR stories for executive and principal engineering interviews.',
      '',
      padSection('STAR Story: Resolving the Split-Brain Replication Outage', [
        'Situation: During a transatlantic fiber cut in 2025, a subtle lease-expiry bug threatened split-brain replication across two storage clusters.',
        'Action & Result: I led the live incident response, isolated the divergent quorum using epoch fencing, and shipped a deterministic simulation regression suite that reduced replication incidents to zero over the following four quarters. #interview #split-brain #outage'
      ]),
      padSection('STAR Story: Zero-Downtime Shard Migration', [
        'Coordinated four platform squads to migrate 180 terabytes of ledger state onto Meridian without violating customer SLA budgets.',
        'Evidências confirmadas demonstram liderança calma sob pressão e rigor na validação pós-incidente.'
      ])
    ].join('\n')
  },
  {
    path: 'context/career.md',
    frontmatter: {
      access_lenses: ['general', 'professional', 'public-voice', 'interview', 'private'],
      disclosure: 'review-required',
      sensitivity: 'personal',
      document_role: 'evidence',
      confidence: 'confirmed',
      supersedes: ['history/2023-career-positioning.md']
    },
    body: [
      '# Principal Engineer Career Progression and Scope',
      '',
      'Current Principal Engineer career positioning, promotion evidence, and multi-team technical scope at Aethelgard Cloud.',
      '',
      padSection('Principal Engineer Scope and Promotion Evidence', [
        'Promoted to Principal Engineer in 2024 after architecting the Meridian storage engine and establishing deterministic simulation testing across three infrastructure tribes.',
        'My current career positioning emphasizes staff-plus technical strategy, storage reliability across forty engineers, and executive technical advisory. #career #principal #promotion'
      ]),
      padSection('Long-Term Career Trajectory', [
        'Targeting Distinguished Engineer or VP of Infrastructure roles at systems-heavy organizations where reliability, privacy, and correctness are core differentiators.',
        'Meu posicionamento atual de carreira reflete liderança técnica de escopo organizacional em sistemas distribuídos.'
      ])
    ].join('\n')
  },
  {
    path: 'context/admin.md',
    frontmatter: {
      access_lenses: ['general', 'private'],
      disclosure: 'internal-only',
      sensitivity: 'personal',
      document_role: 'content'
    },
    body: [
      '# Administrative Logistics and Working Hours',
      '',
      'Timezone, Lisbon office schedule, deep-work calendar blocks, and travel preferences.',
      '',
      padSection('Timezone and Calendar Boundaries', [
        'Operating in WET/WEST (Europe/Lisbon). Core synchronous collaboration window is 10:00 to 16:30 Lisbon time, reserving early mornings for deep architectural work.',
        'No recurring status meetings on Wednesdays or Fridays after 15:00. #admin #logistics'
      ]),
      padSection('Travel and Conference Cadence', [
        'Limit international conference travel to one keynote or systems symposium per quarter, preferring direct rail or morning flights within Europe.',
        'Manter uma rotina previsível garante energia consistente para projetos técnicos complexos.'
      ])
    ].join('\n')
  },
  {
    path: 'context/leadership.md',
    frontmatter: {
      access_lenses: ['general', 'professional', 'public-voice', 'leadership', 'interview', 'private'],
      disclosure: 'review-required',
      sensitivity: 'personal',
      document_role: 'content'
    },
    body: [
      '# Engineering Leadership and Postmortem Philosophy',
      '',
      'Leadership approach for facilitating blameless postmortems, architecture reviews, and cross-team alignment.',
      '',
      padSection('Facilitating Blameless Postmortems', [
        'My leadership approach for facilitating a blameless postmortem focuses on uncovering systemic traps, ambiguous runbooks, and missing automated guardrails rather than individual human error.',
        'During postmortem reviews, I ensure every action item has a bounded owner, an automated verification test, and a two-week completion target. #leadership #postmortem'
      ]),
      padSection('Architectural Stewardship', [
        'Guide staff engineers to frame disagreements as empirical hypotheses that can be settled through benchmark prototypes or simulation runs.',
        'A liderança técnica eficaz combina segurança psicológica com padrões elevados de engenharia.'
      ])
    ].join('\n')
  },
  {
    path: 'context/technical.md',
    frontmatter: {
      access_lenses: ['general', 'professional', 'public-voice', 'technical', 'interview', 'private'],
      disclosure: 'review-required',
      sensitivity: 'personal',
      document_role: 'content',
      supersedes: ['history/2020-early-rust-notes.md']
    },
    body: [
      '# Systems Engineering Stack and Technical Constraints',
      '',
      'Core technical stack across Rust storage kernels, Node.js ESM tooling, SQLite WAL tuning, and Linux kernel I/O.',
      '',
      padSection('Storage Kernel and Runtime Stack', [
        'Production storage nodes run Rust with io_uring asynchronous I/O and CRC32C checksummed log segments, paired with Node.js 22 ESM control-plane services.',
        'For local embedded indexing, we use SQLite in WAL mode with strict foreign keys, bounded page caches, and deterministic query plans. #technical #rust #sqlite'
      ]),
      padSection('Verification Tooling', [
        'Every protocol state machine is verified against deterministic property-based fuzzers before running on multi-node staging clusters.',
        'Preferimos ferramentas enxutas, sem dependências supérfluas, com comportamento determinístico entre Linux, macOS e Windows.'
      ])
    ].join('\n')
  },
  {
    path: 'context/operational-readiness.md',
    frontmatter: {
      access_lenses: ['general', 'professional', 'technical', 'leadership', 'private'],
      disclosure: 'internal-only',
      sensitivity: 'personal',
      document_role: 'content'
    },
    body: [
      '# Production Alert Runbooks and Rotation Exhaustion Mitigation',
      '',
      'Standards for production alert runbooks, rotation exhaustion mitigation, and escalation paging thresholds.',
      '',
      padSection('Alert Signal Quality and Paging Thresholds', [
        'Every high-urgency paging rule must correspond to an immediate customer-visible symptom and link directly to an executable remediation runbook.',
        'We audit noisy alerts monthly and retire any threshold that fires without actionable remediation steps, preventing rotation exhaustion across the platform squad. #alerts #runbooks'
      ]),
      padSection('Service Restoration Drills', [
        'Engineers who complete a heavy primary rotation receive compensatory recovery time and rotate off interrupt duty the following sprint.',
        'Runbooks claros e limites saudáveis de rotação preservam a saúde sustentável da equipe de infraestrutura.'
      ])
    ].join('\n')
  },
  {
    path: 'context/database-storage.md',
    frontmatter: {
      access_lenses: ['general', 'professional', 'technical', 'private'],
      disclosure: 'internal-only',
      sensitivity: 'personal',
      document_role: 'content'
    },
    body: [
      '# B-Tree Page Compaction and Write-Ahead Log Checkpointing',
      '',
      'Deep technical notes on B-tree page compaction, write-ahead log checkpointing, MVCC snapshot isolation, and fsync durability.',
      '',
      padSection('Write-Ahead Log Checkpointing and Fsync Durability', [
        'To bound recovery latency, our storage engine triggers incremental write-ahead log checkpointing whenever uncheckpointed frames exceed sixty-four megabytes.',
        'Every committed frame includes a monotonic epoch header and dual checksums, ensuring fsync durability guarantees even across sudden power loss. #btree #wal #mvcc #fsync'
      ]),
      padSection('B-Tree Page Compaction and MVCC Snapshot Isolation', [
        'Background B-tree page compaction reclaims dead MVCC snapshot isolation tuples without blocking concurrent reader transactions.',
        'Isolamento por snapshot MVCC e compactação incremental evitam degradação de leitura sob cargas intensas de atualização.'
      ])
    ].join('\n')
  },
  {
    path: 'context/onboarding-playbook.md',
    frontmatter: {
      access_lenses: ['general', 'professional', 'technical', 'leadership', 'private'],
      disclosure: 'internal-only',
      sensitivity: 'personal',
      document_role: 'content'
    },
    body: [
      '# 30-60-90 Day Onboarding Playbook for Senior Engineers',
      '',
      'Structured 30-60-90 day onboarding plan for new senior engineers joining the Meridian storage platform.',
      '',
      padSection('Days 1 to 30: Local Simulation and Codebase Fluency', [
        'During the first thirty days of the onboarding plan, new senior engineers pair with a dedicated starter buddy, run the Horologium simulator locally, and ship two bounded bug fixes.',
        'By day sixty, engineers shadow the primary incident rotation and lead an architecture walkthrough of one Raft log subsystem. #onboarding #rampup'
      ]),
      padSection('Days 61 to 90: Autonomous Ownership', [
        'By day ninety, each senior engineer owns a scoped reliability milestone from RFC design through production rollout.',
        'Um plano estruturado de integração acelera a confiança técnica e reduz o tempo até a primeira contribuição significativa.'
      ])
    ].join('\n')
  },
  {
    path: 'context/testing-philosophy.md',
    frontmatter: {
      access_lenses: ['general', 'professional', 'technical', 'private'],
      disclosure: 'internal-only',
      sensitivity: 'personal',
      document_role: 'content'
    },
    body: [
      '# Deterministic Simulation Testing and Fault Injection Harness',
      '',
      'Architecture of our deterministic simulation testing harness for distributed state machines.',
      '',
      padSection('Deterministic Simulation Over Brittle Mocks', [
        'Our deterministic simulation testing harness runs an entire five-node Raft cluster inside a single-threaded seeded event loop with simulated network延迟, packet drops, and disk stalls.',
        'When a property invariant fails, the seed reproduces the exact interleaving in under two hundred milliseconds without flaky sleeps. #simulation #fault-injection'
      ]),
      padSection('Boundary Contract Verification', [
        'Pair simulation harnesses with end-to-end CLI subprocess tests so public flags, exit codes, and JSON schemas never drift from internal unit tests.',
        'Simulação determinística captura condições de corrida raras que testes tradicionais em nuvem raramente reproduzem.'
      ])
    ].join('\n')
  },
  {
    path: 'context/incident-response.md',
    frontmatter: {
      access_lenses: ['general', 'professional', 'technical', 'leadership', 'private'],
      disclosure: 'internal-only',
      sensitivity: 'personal',
      document_role: 'content'
    },
    body: [
      '# Incident Commander Handoffs and Blameless Postmortem Facilitation',
      '',
      'Operational playbook for incident commander handoffs, customer status updates, and blameless postmortem facilitation.',
      '',
      padSection('Incident Commander Handoffs and Status Cadence', [
        'During severity-one outages, the incident commander designates a dedicated scribe and posts verified customer status updates every twenty minutes.',
        'Incident commander handoffs require an explicit written state summary covering active mitigations, ruled-out hypotheses, and next diagnostic probes. #incident #handoffs #postmortem'
      ]),
      padSection('From Mitigation to Systemic Remediation', [
        'Within forty-eight hours of resolution, schedule blameless postmortem facilitation to convert temporary mitigations into permanent invariant checks.',
        'Transições claras de comando durante incidentes evitam perda de contexto sob alta pressão.'
      ])
    ].join('\n')
  },
  {
    path: 'context/mentorship-growth.md',
    frontmatter: {
      access_lenses: ['general', 'professional', 'leadership', 'private'],
      disclosure: 'internal-only',
      sensitivity: 'personal',
      document_role: 'content'
    },
    body: [
      '# Sponsoring Staff Promotions and Coaching Engineers',
      '',
      'Practices for coaching engineers, sponsoring staff promotions, and delegating technical RFCs.',
      '',
      padSection('Sponsoring Staff Promotions', [
        'When sponsoring staff promotions, I co-author the initial architectural charter with the candidate and then hand them visible ownership of cross-tribe design reviews.',
        'Coaching engineers through role transitions means shifting their focus from personal ticket velocity to multiplier effects across adjacent squads. #mentorship #sponsorship'
      ]),
      padSection('Delegating Technical RFCs', [
        'Provide early structural feedback on draft RFCs privately so mentees can present polished, well-defended proposals in public engineering forums.',
        'Patrocinar promoções técnicas exige criar oportunidades reais de impacto visível e autonomia arquitetural.'
      ])
    ].join('\n')
  },
  {
    path: 'context/arquitetura-sistemas-pt.md',
    frontmatter: {
      access_lenses: ['general', 'professional', 'technical', 'leadership', 'private'],
      disclosure: 'internal-only',
      sensitivity: 'personal',
      document_role: 'content'
    },
    body: [
      '# Padrões de Arquitetura Distribuída e Replicação Assíncrona',
      '',
      'Diretrizes em português sobre padrões de arquitetura distribuída, replicação assíncrona, tolerância a falhas bizantinas e particionamento de dados.',
      '',
      padSection('Tolerância a Falhas Bizantinas e Particionamento de Dados', [
        'Nossos padrões de arquitetura distribuída combinam particionamento de dados por faixas de chaves com replicação assíncrona entre regiões geográficas.',
        'Em subsistemas de auditoria crítica, aplicamos verificações criptográficas inspiradas em tolerância a falhas bizantinas para detectar corrupção silenciosa. #arquitetura #replicacao'
      ]),
      padSection('Consistência e Quórum', [
        'Operações de leitura crítica exigem confirmação de quórum líder, enquanto leituras analíticas utilizam réplicas locais com marcadores de época.',
        'O desenho cuidadoso de particionamento de dados garante escalabilidade horizontal previsível.'
      ])
    ].join('\n')
  },
  {
    path: 'context/lideranca-engenharia-pt.md',
    frontmatter: {
      access_lenses: ['general', 'professional', 'leadership', 'interview', 'private'],
      disclosure: 'internal-only',
      sensitivity: 'personal',
      document_role: 'content'
    },
    body: [
      '# Rituais de Liderança Técnica e Mentoria de Engenheiros Seniores',
      '',
      'Práticas de liderança técnica, rituais de revisão de arquitetura e mentoria de engenheiros seniores.',
      '',
      padSection('Mentoria de Engenheiros Seniores e Rituais Técnicos', [
        'Meus rituais de liderança técnica incluem sessões quinzenais de mentoria de engenheiros seniores focadas em escrita de RFCs, negociação de escopo e resolução de conflitos.',
        'Nas reuniões de arquitetura, garantimos que cada decisão documente alternativas descartadas e critérios objetivos de reversão. #lideranca #mentoria'
      ]),
      padSection('Alinhamento Executivo', [
        'Traduzo riscos de infraestrutura em impacto claro de confiabilidade e custo para apoiar o planejamento trimestral da diretoria.',
        'A mentoria contínua prepara novos líderes técnicos para assumirem subsistemas críticos com segurança.'
      ])
    ].join('\n')
  },
  {
    path: 'context/entrevista-casos-pt.md',
    frontmatter: {
      access_lenses: ['general', 'professional', 'interview', 'private'],
      disclosure: 'review-required',
      sensitivity: 'personal',
      document_role: 'evidence',
      confidence: 'confirmed'
    },
    body: [
      '# Histórias para Entrevista Executiva sobre Migração de Bancos de Dados',
      '',
      'Casos estruturados para entrevista executiva detalhando migração de bancos de dados e mitigação de incidentes.',
      '',
      padSection('Migração de Bancos de Dados sem Indisponibilidade', [
        'História principal para entrevista executiva: coordenei a migração de bancos de dados distribuídos com validação dupla de leitura e escrita ao longo de seis semanas.',
        'O projeto reduziu o custo de armazenamento em trinta e cinco por cento e eliminou paradas programadas de manutenção. #entrevista #migracao #bancos-de-dados'
      ]),
      padSection('Lições de Governança Técnica', [
        'Apresento métricas antes-e-depois auditáveis e explico como alinhei quatro equipes de produto durante a virada de chave.',
        'Exemplos concretos de migração de bancos de dados demonstram maturidade operacional em entrevistas de nível Principal.'
      ])
    ].join('\n')
  },
  {
    path: 'context/descoberta-produto-pt.md',
    frontmatter: {
      access_lenses: ['general', 'professional', 'leadership', 'private'],
      disclosure: 'internal-only',
      sensitivity: 'personal',
      document_role: 'content'
    },
    body: [
      '# Validação de Propostas de Produto e Entrevistas com Usuários Corporativos',
      '',
      'Metodologia para validação de propostas de produto, entrevistas com usuários corporativos e métricas de adoção.',
      '',
      padSection('Entrevistas com Usuários Corporativos', [
        'Na validação de propostas de produto para plataforma, conduzimos entrevistas com usuários corporativos focadas em gargalos reais de operação antes de escrever código.',
        'Definimos critérios de sucesso baseados em retenção de uso em trinta dias e redução do tempo de configuração inicial. #produto #validacao #usuarios'
      ]),
      padSection('Prototipação Enxuta', [
        'Construímos protótipos de linha de comando determinísticos para validar fluxos de trabalho com cinco equipes parceiras antes da disponibilidade geral.',
        'O contato direto com usuários corporativos evita investimentos em funcionalidades de baixo impacto.'
      ])
    ].join('\n')
  },

  // ---------------------------------------------------------------------------
  // context/ — Privacy & sensitivity gated documents (7 documents)
  // ---------------------------------------------------------------------------
  {
    path: 'context/people.md',
    frontmatter: {
      access_lenses: ['general', 'leadership', 'private'],
      disclosure: 'internal-only',
      sensitivity: 'third-party-personal',
      document_role: 'content'
    },
    body: [
      '# Direct Report Stakeholder Notes and Performance Calibration',
      '',
      'Confidential stakeholder notes, direct report coaching observations, and performance calibration context.',
      '',
      padSection('Direct Report Performance Calibration', [
        'Direct report stakeholder notes and performance calibration for Q4: Tomás is ready for Staff Engineer nomination after leading the Borealis proxy rollout.',
        'Inês needs broader cross-team RFC visibility in Q1 to strengthen her staff promotion packet, while Sofia is transitioning to lead the simulation squad. #people #calibration'
      ]),
      padSection('Peer Stakeholder Dynamics', [
        'Partner closely with Henrik in Security on zero-trust attestation and align early with Clara in Product on Q1 capacity trade-offs.',
        'Notas de avaliação de terceiros exigem proteção rigorosa sob a lente de liderança.'
      ])
    ].join('\n')
  },
  {
    path: 'context/compensation.md',
    frontmatter: {
      access_lenses: ['general', 'professional', 'interview', 'private'],
      disclosure: 'internal-only',
      sensitivity: 'compensation-confidential',
      document_role: 'content'
    },
    body: [
      '# Base Salary, Equity Grant Bands, and Target Bonus',
      '',
      'Confidential Principal Engineer compensation parameters: base salary, equity grant bands, and target bonus.',
      '',
      padSection('Current Base Salary and Target Bonus', [
        'Current Principal Engineer remuneration package includes a base salary of EUR 215,000, a twenty-five percent annual target bonus, and refresher equity grant bands.',
        'For external Principal or Distinguished roles, my remuneration floor requires a base salary above EUR 235,000 plus liquid or late-stage equity grant bands. #compensation #salary #equity'
      ]),
      padSection('Negotiation Guardrails', [
        'Never disclose historical base salary figures during initial screening calls; anchor discussions on total target remuneration for the role scope.',
        'Dados de remuneração são estritamente confidenciais e restritos às lentes profissional, entrevista e privada.'
      ])
    ].join('\n')
  },
  {
    path: 'context/compensation-pt.md',
    frontmatter: {
      access_lenses: ['general', 'professional', 'interview', 'private'],
      disclosure: 'internal-only',
      sensitivity: 'compensation-confidential',
      document_role: 'content'
    },
    body: [
      '# Pacote de Remuneração Anual, Ações Restritas RSUs e Bônus Alvo',
      '',
      'Registro confidencial do pacote de remuneração anual, ações restritas RSUs, bônus alvo e expectativa salarial.',
      '',
      padSection('Remuneração Anual e Ações Restritas RSUs', [
        'Meu pacote de remuneração anual atual combina salário-base em euros, bônus alvo de vinte e cinco por cento e lotes anuais de ações restritas RSUs.',
        'Para novas oportunidades executivas ou de Principal Engineer, minha expectativa salarial exige revisão integral do lote de ações restritas RSUs. #remuneracao #rsus'
      ]),
      padSection('Política de Confidencialidade Salarial', [
        'Informações sobre pacote de remuneração anual jamais devem ser expostas sob a lente geral de projetos vinculados.',
        'Manter sigilo sobre remuneração protege negociações profissionais futuras.'
      ])
    ].join('\n')
  },
  {
    path: 'context/recruiter-pipeline.md',
    frontmatter: {
      access_lenses: ['general', 'professional', 'interview', 'private'],
      disclosure: 'internal-only',
      sensitivity: 'recruiter-confidential',
      document_role: 'content'
    },
    body: [
      '# Active Recruiter Conversations and Executive Search Pipeline',
      '',
      'Confidential log of active executive search firms, recruiter outreach, and exploratory interview loops.',
      '',
      padSection('Exploratory Executive Search Threads', [
        'Active recruiter conversations in Q4 include exploratory Principal Systems Architect discussions with Northstar Cloud and Velox Database Labs.',
        'Both search threads are in informal architecture chat stages with no formal onsite scheduled before January. #recruiter #pipeline'
      ]),
      padSection('Outreach Filtering Rules', [
        'Decline roles that require relocation outside Europe or lack hands-on distributed systems architecture authority.',
        'Conversas com recrutadores permanecem confidenciais e isoladas de projetos de trabalho.'
      ])
    ].join('\n')
  },
  {
    path: 'context/employer-roadmap.md',
    frontmatter: {
      access_lenses: ['general', 'professional', 'technical', 'leadership', 'interview', 'private'],
      disclosure: 'internal-only',
      sensitivity: 'employer-confidential',
      document_role: 'content'
    },
    body: [
      '# Internal Aethelgard Cloud 2026 Capacity Roadmap and SLA Margin Targets',
      '',
      'Employer-confidential internal Aethelgard Cloud 2026 capacity roadmap, SLA margin targets, and shard topology.',
      '',
      padSection('2026 Capacity Roadmap and SLA Margin Targets', [
        'The internal Aethelgard Cloud 2026 capacity roadmap targets a forty percent reduction in NVMe storage cost per gigabyte while holding 99.995% SLA margin targets.',
        'Phase two consolidates underutilized regional shard pools into dense multi-tenant Meridian cells across Frankfurt and Dublin. #roadmap #sla #capacity'
      ]),
      padSection('Proprietary Topology Constraints', [
        'Internal cell sizing formulas and margin targets are employer-confidential and must not be shared under general or public lenses.',
        'Metas internas de capacidade e margem de SLA exigem proteção sob lentes autorizadas.'
      ])
    ].join('\n')
  },
  {
    path: 'context/application-dossier.md',
    frontmatter: {
      access_lenses: ['general', 'professional', 'interview', 'private'],
      disclosure: 'internal-only',
      sensitivity: 'application-private',
      document_role: 'evidence',
      confidence: 'confirmed'
    },
    body: [
      '# Executive Application Dossier and Reference Contacts',
      '',
      'Application-private dossier containing tailored executive cover narratives and confidential reference contacts.',
      '',
      padSection('Tailored Executive Narratives', [
        'Executive application dossier prepared for Principal and Distinguished Infrastructure roles, highlighting twelve years of consensus storage delivery.',
        'Includes confidential backchannel reference contacts from former VPs of Engineering at Aethelgard and Zephyr. #application #references'
      ]),
      padSection('Handling Rules', [
        'Never expose reference contact details or active application materials under general project lenses.',
        'Dossiês de candidatura são privados para preparação profissional e entrevistas.'
      ])
    ].join('\n')
  },
  {
    path: 'context/restricted-vault.md',
    frontmatter: {
      access_lenses: ['private'],
      disclosure: 'internal-only',
      sensitivity: 'restricted',
      document_role: 'content'
    },
    body: [
      '# Strictly Private Personal Reflections, Health Notes, and Family Estate Planning',
      '',
      'Owner-only restricted vault containing strictly private personal reflections, health notes, and family estate planning.',
      '',
      padSection('Private Health Notes and Family Estate Planning', [
        'RESTRICTED_VAULT_MARKER: Strictly private personal reflections, annual preventive health notes, and Lisbon family estate planning documents.',
        'This document has sensitivity: restricted and access_lenses: [private]; it must never be delivered to any linked project under any lens or budget. #restricted #private'
      ]),
      padSection('Owner-Direct Exclusivity', [
        'Only direct owner calls inside the canonical self root under the private lens may ever read this record.',
        'Registros restritos jamais podem vazar para projetos vinculados.'
      ])
    ].join('\n')
  },
  {
    path: 'context/restricted-medical-pt.md',
    frontmatter: {
      access_lenses: ['private'],
      disclosure: 'internal-only',
      sensitivity: 'restricted',
      document_role: 'content'
    },
    body: [
      '# Registro Médico Privado e Planejamento Patrimonial Familiar',
      '',
      'Documento estritamente restrito com histórico médico privado e notas de planejamento patrimonial familiar.',
      '',
      padSection('Histórico Médico e Dados Familiares', [
        'RESTRICTED_PT_MARKER: Exames clínicos anuais, notas médicas pessoais e documentos de inventário e planejamento patrimonial familiar em Lisboa.',
        'Com sensibilidade restricted e lente exclusiva private, este arquivo jamais pode aparecer em pacotes de projetos vinculados. #restrito #privado'
      ]),
      padSection('Garantia de Isolamento', [
        'Qualquer aparição deste documento em uma avaliação de projeto vinculado constitui violação crítica de privacidade.',
        'Proteção absoluta de dados pessoais sensíveis.'
      ])
    ].join('\n')
  },

  // ---------------------------------------------------------------------------
  // context/ — Additional realistic domain filler documents (5 documents)
  // ---------------------------------------------------------------------------
  {
    path: 'context/observability-telemetry.md',
    frontmatter: {
      access_lenses: ['general', 'professional', 'technical', 'private'],
      disclosure: 'internal-only',
      sensitivity: 'personal',
      document_role: 'content'
    },
    body: [
      '# OpenTelemetry Tracing and Tail-Latency Histograms',
      '',
      'Practices for high-cardinality structured logging, HDR histograms, and distributed trace propagation.',
      '',
      padSection('Tail-Latency Instrumentation', [
        'Record p50, p95, p99, and p99.9 latency histograms at every storage RPC boundary using fixed-bucket HDR counters.',
        'Propagate deterministic trace context headers across Raft append-entries requests to diagnose slow follower disk flushes. #observability #telemetry'
      ]),
      padSection('Cost-Aware Sampling', [
        'Retain one hundred percent of error and slow-path traces while head-sampling healthy read traffic at one percent.',
        'Telemetria estruturada permite diagnóstico rápido sem sobrecarga de armazenamento.'
      ])
    ].join('\n')
  },
  {
    path: 'context/api-versioning.md',
    frontmatter: {
      access_lenses: ['general', 'professional', 'technical', 'private'],
      disclosure: 'internal-only',
      sensitivity: 'personal',
      document_role: 'content'
    },
    body: [
      '# Wire Protocol Evolution and Schema Versioning',
      '',
      'Rules for backward-compatible wire protocol evolution, schema_version increments, and deprecation windows.',
      '',
      padSection('Additive Evolution and Rolling Upgrades', [
        'Every storage RPC message and JSON envelope declares an explicit integer schema_version so mixed-version clusters can perform rolling upgrades safely.',
        'New fields must be optional with deterministic defaults for at least two minor releases before becoming required. #versioning #schemas'
      ]),
      padSection('Deprecation Hygiene', [
        'Emit structured deprecation warnings on stderr for one release cycle before removing legacy CLI flags.',
        'Contratos explícitos de versão evitam quebras silenciosas entre clientes e servidores.'
      ])
    ].join('\n')
  },
  {
    path: 'context/capacity-benchmarking.md',
    frontmatter: {
      access_lenses: ['general', 'professional', 'technical', 'private'],
      disclosure: 'internal-only',
      sensitivity: 'personal',
      document_role: 'content'
    },
    body: [
      '# Reproducible Throughput and Latency Benchmarking',
      '',
      'Methodology for running reproducible storage benchmarks, pinning CPU governors, and warming page caches.',
      '',
      padSection('Cold vs Warm Cache Separation', [
        'Always measure cold-start disk reads separately from warm in-memory and warm OS-page-cache steady states.',
        'Pin CPU frequency governors and isolate background compaction threads before recording baseline p95 latency numbers. #benchmarking #performance'
      ]),
      padSection('Statistical Reporting', [
        'Report min, p50, p95, and max across at least thirty iterations rather than relying on noisy arithmetic means.',
        'Benchmarks reprodutíveis impedem regressões sutis de desempenho.'
      ])
    ].join('\n')
  },
  {
    path: 'context/open-source-stewardship.md',
    frontmatter: {
      access_lenses: ['general', 'professional', 'public-voice', 'technical', 'private'],
      disclosure: 'publish-approved',
      sensitivity: 'personal',
      document_role: 'content'
    },
    body: [
      '# Open-Source Maintenance and Zero-Dependency Design',
      '',
      'Principles for maintaining local-first open-source packages with small attack surfaces and clear contributor guides.',
      '',
      padSection('Minimal Dependency Footprint', [
        'Keeping core CLI packages free of runtime npm dependencies ensures instant installation, deterministic auditing, and multi-year maintenance stability.',
        'Provide clear CONTRIBUTING workflows, automated boundary tests, and reproducible golden fixtures for community contributors. #opensource #stewardship'
      ]),
      padSection('Release Discipline', [
        'Gate every release on cross-platform CI verification across Linux, macOS, and Windows on current Node LTS versions.',
        'Projetos open-source sustentáveis priorizam simplicidade e testes automatizados rigorosos.'
      ])
    ].join('\n')
  },
  {
    path: 'context/architecture-guardrails.md',
    frontmatter: {
      access_lenses: ['general', 'professional', 'technical', 'leadership', 'private'],
      disclosure: 'internal-only',
      sensitivity: 'personal',
      document_role: 'content'
    },
    body: [
      '# Module Boundaries and Acyclic Dependency Graphs',
      '',
      'Architectural rules keeping domain modules decoupled, testable, and free of circular imports.',
      '',
      padSection('Layered Module Responsibilities', [
        'Separate caller resolution, policy authorization, candidate ranking, record delivery, and packet envelope fitting into distinct, single-responsibility modules.',
        'Enforce repository boundary rules in CI so product runtime modules never import from test harnesses or external workflow tooling. #architecture #boundaries'
      ]),
      padSection('Helper Consolidation', [
        'Avoid duplicating YAML parsers, tokenizers, or atomic file writers across modules; consolidate shared primitives in dedicated utility modules.',
        'Fronteiras modulares claras facilitam refatorações seguras sem alteração de comportamento.'
      ])
    ].join('\n')
  },

  // ---------------------------------------------------------------------------
  // history/ — Lifecycle documents (10 documents: superseded, historical, expired)
  // ---------------------------------------------------------------------------
  {
    path: 'history/2023-career-positioning.md',
    frontmatter: {
      access_lenses: ['general', 'professional', 'interview', 'private'],
      disclosure: 'internal-only',
      sensitivity: 'personal',
      document_role: 'content',
      knowledge_status: 'superseded',
      superseded_by: 'context/career.md',
      temporal_scope: 'historical'
    },
    body: [
      '# 2023 Senior Backend Career Positioning (Superseded)',
      '',
      'Superseded 2023 career positioning statement written before the 2024 Principal Engineer promotion.',
      '',
      padSection('2023 Senior Backend Focus', [
        'SUPERSEDED_2023_CAREER: In 2023 my career positioning focused on transitioning from Senior Backend Engineer to Staff Engineer on the billing monolith.',
        'This record is superseded by context/career.md and must be excluded from current context queries unless superseded history is requested. #superseded #career'
      ])
    ].join('\n')
  },
  {
    path: 'history/2022-monolith-architecture.md',
    frontmatter: {
      access_lenses: ['general', 'professional', 'technical', 'private'],
      disclosure: 'internal-only',
      sensitivity: 'personal',
      document_role: 'content',
      knowledge_status: 'superseded',
      superseded_by: 'context/decisions.md',
      temporal_scope: 'historical'
    },
    body: [
      '# Synchronous REST Monolith Architecture Notes (2022 Superseded)',
      '',
      'Superseded 2022 synchronous REST monolith architecture notes prior to the Meridian Raft consensus migration.',
      '',
      padSection('Legacy Synchronous REST Monolith', [
        'SUPERSEDED_2022_MONOLITH: The 2022 synchronous REST monolith architecture relied on a single primary PostgreSQL instance with manual failover scripts.',
        'Superseded by ADR-014 in context/decisions.md when Meridian Raft consensus became the canonical storage architecture. #superseded #monolith'
      ])
    ].join('\n')
  },
  {
    path: 'history/2024-q1-okrs.md',
    frontmatter: {
      access_lenses: ['general', 'professional', 'leadership', 'private'],
      disclosure: 'internal-only',
      sensitivity: 'personal',
      document_role: 'content',
      knowledge_status: 'historical',
      temporal_scope: 'historical',
      valid_from: '2024-01-01',
      valid_until: '2024-03-31'
    },
    body: [
      '# Historical Q1 2024 Team OKRs and Datacenter Decommissioning',
      '',
      'Completed Q1 2024 team OKRs covering the legacy Amsterdam datacenter decommissioning milestone.',
      '',
      padSection('Q1 2024 Decommissioning Outcomes', [
        'HISTORICAL_2024_Q1_OKRS: Completed decommissioning of the legacy Amsterdam bare-metal racks in March 2024 with zero customer data loss.',
        'Recorded as historical knowledge for retrospective reference only. #historical #okrs'
      ])
    ].join('\n')
  },
  {
    path: 'history/2021-previous-employer.md',
    frontmatter: {
      access_lenses: ['general', 'professional', 'interview', 'private'],
      disclosure: 'review-required',
      sensitivity: 'personal',
      document_role: 'evidence',
      confidence: 'confirmed',
      knowledge_status: 'historical',
      temporal_scope: 'historical',
      valid_from: '2019-02-01',
      valid_until: '2021-11-30'
    },
    body: [
      '# Zephyr FinTech Payment Clearing Pipelines (2019–2021 Historical)',
      '',
      'Historical tenure at Zephyr FinTech designing SEPA instant payment clearing pipelines and idempotency ledgers.',
      '',
      padSection('Zephyr FinTech Payment Clearing Architecture', [
        'HISTORICAL_ZEPHYR_2021: From 2019 to 2021 at Zephyr FinTech, I led the five-engineer squad responsible for SEPA payment clearing pipelines and double-entry settlement.',
        'Delivered idempotent clearing processors handling four hundred thousand daily transactions with zero reconciliation drift. #historical #zephyr #payments'
      ])
    ].join('\n')
  },
  {
    path: 'history/expired-2024-sprint-goals.md',
    frontmatter: {
      access_lenses: ['general', 'professional', 'technical', 'private'],
      disclosure: 'internal-only',
      sensitivity: 'personal',
      document_role: 'content',
      knowledge_status: 'current',
      temporal_scope: 'time-bounded',
      valid_from: '2024-04-01',
      valid_until: '2024-06-30'
    },
    body: [
      '# Expired Q2 2024 Sprint Goals for Storage Milestones',
      '',
      'Time-bounded sprint goals for Q2 2024 storage milestones whose valid_until date (2024-06-30) has expired.',
      '',
      padSection('Q2 2024 Temporary Freeze Window', [
        'EXPIRED_2024_SPRINT_GOALS: Temporary sprint goals for Q2 2024 storage milestones during the June 2024 schema freeze.',
        'Although knowledge_status was left as current, valid_until is 2024-06-30 so temporalDisposition automatically excludes this expired record under current queries. #expired #sprint'
      ])
    ].join('\n')
  },
  {
    path: 'history/2023-estilo-escrita-pt.md',
    frontmatter: {
      access_lenses: ['general', 'public-voice', 'private'],
      disclosure: 'internal-only',
      sensitivity: 'personal',
      document_role: 'content',
      knowledge_status: 'superseded',
      superseded_by: 'profile/voice.md',
      temporal_scope: 'historical'
    },
    body: [
      '# Guia Antigo de Estilo de Escrita e Voz Editorial (2023 Substituído)',
      '',
      'Guia de estilo de escrita de 2023 substituído pelo documento atual profile/voice.md.',
      '',
      padSection('Recomendações Antigas de 2023', [
        'SUPERSEDED_ESTILO_2023: Este guia antigo de estilo de escrita utilizava introduções longas e acadêmicas antes da revisão editorial de 2024.',
        'Substituído por profile/voice.md; não deve ser incluído em consultas de contexto atual. #substituido #escrita'
      ])
    ].join('\n')
  },
  {
    path: 'history/2022-historico-lideranca-pt.md',
    frontmatter: {
      access_lenses: ['general', 'professional', 'leadership', 'private'],
      disclosure: 'internal-only',
      sensitivity: 'personal',
      document_role: 'content',
      knowledge_status: 'historical',
      temporal_scope: 'historical',
      valid_from: '2022-01-01',
      valid_until: '2022-12-31'
    },
    body: [
      '# Gestão de Equipes Durante a Transição Remota em 2022 (Histórico)',
      '',
      'Registro histórico sobre gestão de equipes durante a transição remota em 2022.',
      '',
      padSection('Transição Remota em 2022', [
        'HISTORICAL_LIDERANCA_2022: Durante a transição remota em 2022, estruturei rituais escritos diários e acordos de fuso horário para três equipes de plataforma.',
        'Mantido no diretório history/ como evidência histórica de gestão em 2022. #historico #remoto'
      ])
    ].join('\n')
  },
  {
    path: 'history/expired-2024-metas-pt.md',
    frontmatter: {
      access_lenses: ['general', 'professional', 'private'],
      disclosure: 'internal-only',
      sensitivity: 'personal',
      document_role: 'content',
      knowledge_status: 'current',
      temporal_scope: 'time-bounded',
      valid_from: '2024-01-01',
      valid_until: '2024-05-31'
    },
    body: [
      '# Metas Temporárias do Primeiro Semestre de 2024 (Expirado)',
      '',
      'Documento de estilo de escrita e metas temporárias com valid_until expirado em 2024-05-31.',
      '',
      padSection('Metas Expiradas de Maio de 2024', [
        'EXPIRED_METAS_2024_PT: Estas metas temporárias de escrita e entrega venceram em 31 de maio de 2024.',
        'Deve ser filtrado automaticamente pelo seletor temporal padrão current. #expirado #metas'
      ])
    ].join('\n')
  },
  {
    path: 'history/2020-early-rust-notes.md',
    frontmatter: {
      access_lenses: ['general', 'technical', 'private'],
      disclosure: 'internal-only',
      sensitivity: 'personal',
      document_role: 'content',
      knowledge_status: 'superseded',
      superseded_by: 'context/technical.md',
      temporal_scope: 'historical'
    },
    body: [
      '# Early 2020 Async Rust Prototype Notes (Superseded)',
      '',
      'Superseded 2020 notes on early async Rust executors before adopting io_uring in production.',
      '',
      padSection('2020 Executor Experiments', [
        'SUPERSEDED_RUST_2020: Early 2020 experiments with pre-1.0 async Rust futures and epoll sockets.',
        'Superseded by context/technical.md which documents our current io_uring storage kernel stack. #superseded #rust'
      ])
    ].join('\n')
  },
  {
    path: 'history/2023-compensation-band.md',
    frontmatter: {
      access_lenses: ['general', 'professional', 'interview', 'private'],
      disclosure: 'internal-only',
      sensitivity: 'compensation-confidential',
      document_role: 'content',
      knowledge_status: 'historical',
      temporal_scope: 'historical',
      valid_from: '2023-01-01',
      valid_until: '2023-12-31'
    },
    body: [
      '# 2023 Staff Engineer Compensation Band (Historical Confidential)',
      '',
      'Historical 2023 Staff Engineer base salary and bonus figures prior to the 2024 Principal promotion.',
      '',
      padSection('2023 Staff Compensation Record', [
        'HISTORICAL_2023_COMPENSATION: In 2023 as a Staff Engineer, base salary was EUR 175,000 with a twenty percent target bonus.',
        'Both historical and compensation-confidential: excluded under current queries and forbidden under general lens. #historical #compensation'
      ])
    ].join('\n')
  }
])

const canonical = value => (process.platform === 'win32' ? value.toLowerCase() : value)
const within = (parent, child) => {
  const rel = relative(parent, child)
  return rel !== '' && !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)
}

// In-process CLI run with optional environment overrides restored afterwards (the fixture's self map directory must be
// the one its subprocesses use, never the developer's real configuration directory).
async function quietRun(args, envOverrides = {}) {
  const origLog = console.log
  const origErr = console.error
  const savedEnv = Object.fromEntries(Object.keys(envOverrides).map(key => [key, process.env[key]]))
  console.log = () => {}
  console.error = () => {}
  Object.assign(process.env, envOverrides)
  try {
    await run(args)
  } finally {
    console.log = origLog
    console.error = origErr
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

export function cleanSubprocessEnv(homeDir) {
  const env = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (!/^(HOLOSELF_|CLAUDE|CODEX|OPENRIG|MESHLOOP|NODE_TEST)/i.test(key)) env[key] = value
  }
  return {
    ...env,
    HOME: homeDir,
    USERPROFILE: homeDir,
    XDG_CONFIG_HOME: join(homeDir, '.config'),
    HOLOSELF_CONFIG_DIR: join(homeDir, '.config', 'holoself'),
    NO_COLOR: '1',
    TZ: 'UTC'
  }
}

export function corpusDigest() {
  const payload = SYNTHETIC_DOCUMENTS.map(doc => [doc.path, doc.frontmatter, doc.body])
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex')
}

export async function createRetrievalEvalFixture({ baseDir } = {}) {
  const temporaryParent = realpathSync(tmpdir())
  const parent = realpathSync(resolve(baseDir || temporaryParent))
  if (canonical(parent) !== canonical(temporaryParent) && !within(temporaryParent, parent)) {
    throw new Error('retrieval-eval fixture parent must be inside the system temporary directory')
  }
  const rawRoot = await mkdtemp(join(parent, 'holoself-retrieval-eval-'))
  const root = realpathSync(rawRoot)
  const identity = lstatSync(root)
  let cleaned = false

  const cleanup = async () => {
    if (cleaned) return
    const current = lstatSync(root)
    if (current.isSymbolicLink() || !current.isDirectory() || current.dev !== identity.dev || current.ino !== identity.ino) {
      throw new Error('retrieval-eval fixture root was replaced; refusing cleanup')
    }
    const actualRoot = realpathSync(root)
    const actualParent = realpathSync(dirname(root))
    if (
      canonical(actualRoot) !== canonical(root) ||
      canonical(actualParent) !== canonical(parent) ||
      !within(actualParent, actualRoot) ||
      !basename(actualRoot).startsWith('holoself-retrieval-eval-')
    ) {
      throw new Error('unsafe retrieval-eval fixture cleanup boundary')
    }
    await rm(root, { recursive: true, force: false })
    cleaned = true
  }

  try {
    const self = join(root, 'self')
    const project = join(root, 'project')
    const home = join(root, 'home')
    await Promise.all([self, project, home].map(dir => mkdir(dir, { recursive: true })))

    await quietRun(['init', '--root', self])

    // Disable default public contribs so context selection evaluates the synthetic self corpus cleanly.
    const configFile = join(self, 'config.json')
    await writeFile(
      configFile,
      JSON.stringify(
        {
          schemaVersion: 1,
          product: 'holoself',
          selectedContribs: [],
          createdAt: '2025-01-15T12:00:00.000Z'
        },
        null,
        2
      ) + '\n'
    )

    // Configure custom session_start_sources on the technical lens to test lens-specific session-start selection.
    const technicalLensPath = join(self, 'lenses', 'technical.json')
    await writeFile(
      technicalLensPath,
      JSON.stringify(
        {
          schema_version: 1,
          id: 'technical',
          title: 'Technical',
          sensitivity_access: ['employer-confidential'],
          instructions: {
            purpose: 'Technical delivery and architecture context',
            priorities: ['technical evidence'],
            include: [],
            exclude: [],
            response_guidance: []
          },
          session_start_sources: ['profile/identity.md', 'profile/preferences.md', 'context/technical.md']
        },
        null,
        2
      ) + '\n'
    )

    // Materialize all 48 synthetic documents across profile/, context/, and history/.
    const writtenPaths = []
    for (const doc of SYNTHETIC_DOCUMENTS) {
      const fullPath = join(self, doc.path)
      await mkdir(dirname(fullPath), { recursive: true })
      const content = `${frontmatterBlock(doc.frontmatter)}${doc.body.trim()}\n`
      await writeFile(fullPath, content, 'utf8')
      await utimes(fullPath, FIXED_MTIME, FIXED_MTIME)
      writtenPaths.push(fullPath)
    }

    // Link the synthetic project with general as default lens and all non-private lenses as secondary lenses.
    await quietRun([
      'link',
      'add',
      '--project',
      project,
      '--self',
      self,
      '--lens',
      'general',
      '--secondary-lenses',
      LINKED_SECONDARY_LENSES.join(','),
      '--no-activate',
      '--no-mcp',
      '--no-hooks',
      '--yes'
    ], { HOLOSELF_CONFIG_DIR: join(home, '.config', 'holoself') })

    // Prime the on-disk catalog once so subsequent CLI subprocesses execute against a warm, deterministic catalog.
    const env = cleanSubprocessEnv(home)
    const prime = spawnSync(process.execPath, [HOLOSELF_BIN, 'context', '--project', project, '--budget', 'small', '--json'], {
      cwd: project,
      env,
      encoding: 'utf8',
      windowsHide: true
    })
    if (prime.status !== 0) {
      throw new Error(`failed to prime retrieval-eval catalog: ${prime.stderr || prime.stdout}`)
    }

    return {
      root,
      self,
      project,
      home,
      env,
      documentCount: SYNTHETIC_DOCUMENTS.length,
      corpusDigest: corpusDigest(),
      cleanup
    }
  } catch (error) {
    await cleanup().catch(() => {})
    throw error
  }
}
