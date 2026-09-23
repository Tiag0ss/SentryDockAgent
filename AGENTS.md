<!-- cursor-ai-kit: generated -->
# Agent context

Cursor agents: read scoped rules under `.cursor/rules/` and skills under `.cursor/skills/`.

## Language (mandatory)

- **Assistant replies: English (EN) only.**
- User messages may be in European Portuguese (PT). Understand PT; do not answer in PT or PT-BR unless explicitly requested.
- Non-English UI strings require user approval.

## Applied packs

- `common`
- `docker`
- `testing`

## Rules and skills by pack

## Common

Always-on: language/workflow (includes structure discipline), security. Glob: types/errors, React components.

| Rule | When |
|------|------|
| `language-and-workflow.mdc` | Always — EN, YAGNI, **follow stack structure rules** |
| `security.mdc` | Always |
| `types-and-errors.mdc` | `**/*.{ts,tsx,js}` |
| `react-components.mdc` | `**/*.{tsx,jsx}` — small reusable components |

| Skill | When |
|-------|------|
| `git-commit` | User asks to commit |
| `new-change` | Implementing a change (definition of done) |
| `code-review` | Reviewing diffs or PRs |

**Structure policy:** greenfield → kit canonical folders. Existing consistent layout → match it; do not mass-migrate unless asked.

## Docker

| Rule | When |
|------|------|
| `docker.mdc` | `Dockerfile*`, `compose*.yml`, `docker-compose*.yml` |

| Skill | When |
|-------|------|
| `deploy-docker` | Containerising or deploying with Docker |

Copied into the destination:

| Path | Contents |
|------|----------|
| `deploy/scripts/deploy.sh` | Local build + compose up (env: `IMAGE`, `COMPOSE_FILE`, `SKIP_BUILD`, `SKIP_UP`) |
| `deploy/templates/nextjs/` | Next.js standalone Dockerfile + compose |
| `deploy/templates/node/` | Node/Express TypeScript multi-stage |
| `deploy/templates/csharp/` | .NET publish (set `PROJECT` / `DLL` build args) |
| `deploy/templates/static-nginx/` | Non-root nginx on 8080 |

Adapt a template into the project root; do not invent unused services.

## Testing

| Rule | When |
|------|------|
| `testing.mdc` | Test files and `tests/` / `__tests__/` trees |

| Skill | When |
|-------|------|
| `add-tests` | Adding or updating tests |

Use the repo’s existing runner. Do not introduce a new test framework unasked.

## Notes

- Prefer minimal diffs. Commit only when the user asks.
- Product-specific conventions belong in project rules — keep them out of copied kit defaults when customizing.
- Pack list is recorded in `.cursor/kit-manifest.txt`. Re-apply with the same or updated `--packs` to refresh kit-managed files.
