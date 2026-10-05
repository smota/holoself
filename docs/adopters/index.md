# Adopter path

Use this route to evaluate or add AgentFlow to an existing repository without surrendering local
policy or accepting an opaque write.

1. Run the [read-only evaluation](../agent-workflow.md).
2. Choose an [install profile](profiles.md).
3. Preview exact changes with `adopt plan`.
4. Resolve conflicts; approve only the current plan token.
5. Apply with an external receipt, then validate the target.
6. Add a source adapter or provider only when the project needs it.
7. Run a first issue through the documented workflow.

The core works with manual execution. A missing Claude, Codex, Agy, Pi, Grok, or AI Foundry Desk
binary does not block adoption unless project policy explicitly requires that provider capability.

For an existing v1 installation, start with [install profiles](profiles.md).
For resuming or transferring active work across agent harnesses, see [run operations](../run-operations.md).
