---
name: code-review
description: >-
  Review code for correctness, security, tests, and unnecessary complexity.
  Use when reviewing a PR, a diff, or when the user asks for a code review.
---

# Code review

Check:

- [ ] Correctness and edge cases
- [ ] **Structure** — files in canonical folders/layers (not god-files in the wrong place)
- [ ] Security (injection, secrets, authz on mutations, sensitive logs)
- [ ] Tests for new/changed logic or API (not required for copy/CSS-only)
- [ ] Complexity / giant files — prefer smaller units and reuse
- [ ] Diff size — flag unrelated changes

Feedback format:

- **Critical** — must fix before merge
- **Suggestion** — worth improving
- **Nice to have** — optional

Keep comments concrete (file + what to change). Prefer English.
