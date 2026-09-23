---
name: new-change
description: >-
  Definition of done for implementing a feature or fix: minimal diff, tests when
  logic or API changes, run existing lint/test if present. Use when implementing
  a change, finishing a task, or checking whether work is complete.
---

# New change — definition of done

1. **Structure**: place new files per the stack structure rule (`*-structure.mdc`). No parallel folder trees.
2. **Smallest diff** that meets the request. Match existing patterns; no drive-by refactors.
3. **Tests** when adding or changing logic or an API. Skip for pure copy/CSS-only edits unless the user asks.
4. If the repo already has test/lint scripts, run the relevant ones before claiming done.
5. Do not add a new test framework or dependency unless the user asks.
6. For user-visible UI: loading/empty/error where needed; verify in the browser when possible.
7. No secrets in the diff. No empty catch. Server mutations stay authorized server-side.
