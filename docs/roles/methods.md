# Role methods and project customization

AgentFlow keeps lifecycle accountability stable while allowing teams to choose how they perform a
role. A method play may add inputs, outputs, evidence fields, behavior steps, templates, tools, or
validators. It cannot transfer ownership, modify the core transition graph, widen authority, or
weaken review and human gates.

## Composition

```text
RoleDefinition
+ WorkflowProfile
+ MethodPlays
+ ProjectPolicy
+ RunParameters
= EffectiveRoleContract
```

Core invariants have highest precedence. Later layers may add requirements or narrow authority;
they cannot subtract safeguards. Arbitrary object merging is deliberately unsupported.

## Project configuration

Select methods in `agent-workflow.config.json`:

```json
{
  "roleMethods": {
    "bindings": {
      "agentflow:product-manager": ["agentflow:method:jtbd"],
      "agentflow:analyst": [
        {
          "method": "agentflow:method:event-storming",
          "parameters": { "includeExternalActors": true }
        }
      ],
      "agentflow:developer": [
        {
          "method": "agentflow:method:tdd",
          "parameters": { "allowCharacterizationFirst": true }
        }
      ]
    }
  }
}
```

`roles resolve` applies defaults, validates parameter types, rejects unknown parameters, and emits
the effective contract without modifying the project.

## Built-in methods

The catalog includes JTBD, event storming, ADR-driven architecture, vertical-slice planning, TDD,
risk-based testing, security review, Diataxis, and trunk-based readiness. They are examples of the
extension contract, not required methodologies.

Third parties should use their own namespace, such as `acme.example:method:regulated-analysis`.
Namespaced methods may target an AgentFlow role, but their manifest must pass the same invariant and
parameter checks.

## Method versus extension pack

A method is role-bound behavior. An extension pack distributes one or more methods together with
documentation, templates, tools, and validators. Existing extension-pack `plays` should reference
the method identity as they migrate to the typed method catalog. Enabling a pack remains explicit.
