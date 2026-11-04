# Synthetic linked-project example

This example uses invented data only.

```text
C:/demo/alex-self/
  profile/identity.md
  context/claims.md
  context/evidence.md
  context/public-disclosure.md

C:/demo/professional-project/
  applications/
  research/
  .holoself/link.yaml

C:/demo/public-voice-project/
  posts/
  calendar/
  .holoself/link.yaml
```

The professional project link uses the `professional` lens; the public-voice project link uses the `public-voice` lens. Both point to the same whole-person self context. The professional project keeps applications and negotiation details. The public-voice project keeps posts and engagement data.

Suppose the professional project verifies synthetic claim “Led a 12-person platform team.” It creates proposal with source file, evidence, confidence, and private visibility. User reviews diff and approves. Claim becomes reusable self knowledge with provenance. Private claims remain exclusive to the owner. The public-voice lens uses normal document and field access rules. Reading context never authorizes publication or another external action.

```bash
node bin/holoself.mjs link add --project C:/demo/professional-project --self C:/demo/alex-self --lens professional
node bin/holoself.mjs link add --project C:/demo/public-voice-project --self C:/demo/alex-self --lens public-voice
```

No project clones full profile. No engagement metric becomes personal belief automatically. No proposal bypasses review.
