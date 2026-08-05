# Skills and Gatekeepers

Cloudflare OS Gatekeepers enforce authority; skills teach the agent when and how to use that authority. A skill never contains credentials and does not bypass a Gatekeeper.

| Capability | Agent guidance | Worker | Status |
| --- | --- | --- | --- |
| Organization | `skills/organization/SKILL.md` | `packages/custom-gatekeeper` | Canonical, read-only |
| Asana | `skills/asana/SKILL.md` | `packages/gatekeeper-asana` | Read-only; token/workspace required |
| QuickBooks | `skills/quickbooks/SKILL.md` | `packages/gatekeeper-quickbooks` | Read-only synthetic simulation |
| AWS | `skills/aws/SKILL.md` | `packages/gatekeeper-aws` | Read-only; least-privilege credentials required |

The public API for each capability is its `src/types.d.ts`; its JSDoc is the agent-facing reference. Every provider read calls `authorizeObservation()`. No current session interface exposes a method with external side effects.

To add a capability, design and review the narrow session API first, then implement authentication, observation or staged-action handling, resource scoping, observer verification, tests, deployment binding, and a companion skill. Follow the pinned upstream `write-gatekeeper` guidance.
