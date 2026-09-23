---
name: add-tests
description: >-
  Add or update tests using the project's existing runner and layout. Use when
  writing unit, integration, or e2e tests, or when a change needs coverage.
---

# Add tests

1. Detect the runner from `package.json`, `.csproj`, `pytest.ini`, or existing `*.test.*` / `tests/`.
2. Match colocated vs `tests/` layout already used. Do not invent a second tree.
3. Cover the change: happy path + one failure/authz/validation case when relevant.
4. Do not add new test dependencies unless the user asks.
5. Run the existing test script for the touched area when available.
6. Keep tests focused; avoid snapshot spam and brittle full-DOM assertions unless that is the project style.
