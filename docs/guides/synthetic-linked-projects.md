# Synthetic linked-project example

This example uses invented data only.

```text
C:/demo/alex-self/
  profile/identity.md
  context/claims.md
  context/evidence.md
  context/public-disclosure.md

C:/demo/career-project/
  applications/
  research/
  .holoself/link.yaml

C:/demo/publishing-project/
  posts/
  calendar/
  .holoself/link.yaml
```

Career link uses `professional` lens; publishing link uses `public-voice` lens. Both point to same whole-person self context. Career keeps applications and negotiation details. Publishing keeps posts and engagement data.

Suppose career project verifies synthetic claim “Led a 12-person platform team.” It creates proposal with source file, evidence, confidence, and private visibility. User reviews diff and approves. Claim becomes reusable self knowledge with provenance. Private claims remain exclusive to the owner. The public-voice lens uses normal document and field access rules. Reading context never authorizes publication or another external action.

```bash
node bin/holoself.mjs link add --project C:/demo/career-project --self C:/demo/alex-self --lens professional
node bin/holoself.mjs link add --project C:/demo/publishing-project --self C:/demo/alex-self --lens public-voice
```

No project clones full profile. No engagement metric becomes personal belief automatically. No proposal bypasses review.
