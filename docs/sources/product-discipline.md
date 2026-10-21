# Product Management Discipline and Methodology

This document defines the product management discipline, Jobs-to-be-Done (JTBD) methodology,
and Spec-Driven Development practices codified in AgentFlow SDLC.

All autonomous agents and human developers operating within AgentFlow consult this reference
to establish product problem boundaries, evaluate customer progress, and construct testable
specifications before engineering begins.

---

## 1. Authority and Sources

AgentFlow SDLC maintains strict internal self-sufficiency. Agent instructions never load external
URLs at runtime. The core methodologies in this document synthesize the following industry
standards, cited here for provenance:

1. **Jobs-to-be-Done (JTBD) Framework**:
   - Clayton Christensen (_The Innovator's Solution_, _Competing Against Luck_).
   - Dean Peters, _Jobs-to-be-Done Product Manager Skill_ (github.com/deanpeters/Product-Manager-Skills).
   - Rampstack, _JTBD Framing as Applied Product Methodology_ (skillsdirectory.com/skills/rampstackco-jtbd-framing).
2. **Spec-Driven Development**:
   - Addy Osmani, _Spec-Driven Development Agent Skill_ (skills.sh/addyosmani/agent-skills/spec-driven-development).
3. **Product Management Disciplines & Taxonomy**:
   - Product Map, _15 Essential Product Management Skills_ (productmap.io/product-management-skills).
4. **AI-Native Product Management Operations**:
   - MindStudio, _AI Agents for Product Managers_ (mindstudio.ai/blog/ai-agents-for-product-managers).

---

## 2. The Jobs-to-be-Done (JTBD) Framework

### 2.1 The Core Invariant: Job vs. Solution

Users do not buy products or features; they hire solutions to make progress in a specific
circumstance. The job exists independently of the software built to address it.

- **Anti-Pattern (Feature-Request / Prompt-Echoing)**: An agent treats user prompts as direct
  specifications ("The user asked for a modal, so we build a modal"). This produces superficial
  code without solving the underlying problem.
- **Applied Discipline (Job Framing)**: The product manager deconstructs the request to identify
  the struggling moment and the desired outcome before designing software.

### 2.2 Canonical Job Statement Structure

Every product initiative must state the customer job using the canonical syntax:

```text
When [situation or trigger],
I want to [motivation or action],
so I can [desired outcome or progress].
```

- **Situation**: The specific context where friction arises. Not a demographic persona.
- **Motivation**: What the user tries to accomplish in that situation.
- **Outcome**: The observable definition of success; the functional, emotional, or social progress.

### 2.3 The Four Forces of Progress

Every transition from an existing solution to a new solution is governed by four competing forces:

1. **Push of the Current Situation**: The pain, friction, workarounds, or failures of current tools.
2. **Pull of the New Solution**: The promised gain, relief, or superior capability of the new approach.
3. **Anxiety of the New Solution**: Fear of bugs, data loss, learning curve, or migration overhead.
4. **Inertia of Current Habits**: Comfort with existing workflows, muscle memory, and switching costs.

Adoption occurs only when: `(Push + Pull) > (Anxiety + Inertia)`.

### 2.4 Three Dimensions of Jobs

- **Functional Job**: The practical task to perform (e.g., "revert an erroneous state transition").
- **Emotional Job**: How the user feels (e.g., "feel confident that recovery will not lose data").
- **Social Job**: How the user is perceived (e.g., "demonstrate rigorous audit compliance to reviewers").

---

## 3. Spec-Driven Development

Code written without a structured specification is guesswork. AgentFlow enforces a four-phase
gated workflow before implementation:

```text
SCOPE CHECK (Phase 0) ---> SPECIFY (Phase 1) ---> PLAN (Phase 2 & 3) ---> IMPLEMENT (Phase 4)
```

### 3.1 Phase 0: Scope Check and Capability Mapping

When an initiative bundles multiple independently testable capabilities, the analyst must decompose
it into a **Capability Map** before drafting individual specifications:

- **Stable Module IDs**: Use kebab-case identifiers (`identity`, `billing`, `state-machine`). Module IDs
  are immutable during the initiative.
- **Unidirectional Dependency Direction**: Dependencies point in a single direction (`billing -> identity`).
  Circular dependencies are forbidden. If module A depends on module B and module B depends on module A,
  they are a single module.
- **Build Order**: Slices build from lowest dependency to highest consumer.

### 3.2 Assumptions Register

Assumptions cause more delivery failures than syntax bugs. Every specification must begin with an
explicit register:

```markdown
### Assumptions Register

1. Database schema migrations run before application worker restart.
2. The runtime environment provides Node.js >= 20.
3. Network calls to third-party endpoints may time out after 5000ms.
```

Delivery teams (`agentflow:architect`) inspect this register during intake. If an assumption is
refuted by codebase reality, the architect triggers a Phase 2 Return to the analyst.

### 3.3 Testable Acceptance Boundaries

Acceptance criteria must be black-box testable:

- Express behavior in observable states (`Given [state], When [action], Then [observable outcome]`).
- Specify explicit **Anti-Goals** (what the change explicitly must NOT do).
- Define out-of-scope boundaries to prevent scope creep during implementation.

---

## 4. The Five Core Product Management Disciplines

AgentFlow consolidates product management into two coordination roles (`agentflow:product-manager`
and `agentflow:analyst`) that operate across five core disciplines:

| Domain           | Focus                                                | Artifact Ownership                   |
| :--------------- | :--------------------------------------------------- | :----------------------------------- |
| **1. Product**   | Strategy, problem framing, JTBD, release intent      | `.agentflow/PRODUCT.md`, Goal record |
| **2. Customer**  | Struggling moments, user journeys, friction analysis | `JTBD.md`, User journey maps         |
| **3. Analytics** | Measurable outcomes, KPIs, telemetry requirements    | Success metric contracts             |
| **4. Process**   | Capability mapping, Spec-Driven Development          | `CAPABILITY-MAP.md`, `SPEC.md`       |
| **5. People**    | Transparent decision rationale, stakeholder clarity  | Architecture & PR manifest reviews   |

---

## 5. Bidirectional Seam Protocol

Product management and delivery operate in a continuous verification loop.

### 5.1 Forward Handoff (Phase 1 -> Phase 2)

The analyst delivers:

1. Validated problem and job statements.
2. Verified capability map.
3. Assumptions register.
4. Testable acceptance criteria with anti-goals.

### 5.2 Reverse Seam Trigger (Phase 2/3/4 -> Phase 1)

When delivery identifies an assumption defect, technical infeasibility, or scope expansion from a
direct human prompt:

1. Delivery halts code modification.
2. The architect records a transition skip naming `return to phase 1`.
3. The analyst adjusts the specification or capability map.
4. The analyst hands the revised specification back to delivery.
