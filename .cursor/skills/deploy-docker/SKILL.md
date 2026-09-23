---
name: deploy-docker
description: >-
  Containerise or deploy with Docker Compose using project templates and
  deploy.sh. Use when the user asks to dockerize, write a Dockerfile, compose
  file, or run a local Docker deploy.
---

# Deploy Docker

1. Pick a template under `deploy/templates/` that matches the stack (`nextjs`, `node`, `csharp`, `static-nginx`), or adapt the closest one.
2. Copy/adapt into the project root as `Dockerfile` / `compose.yml` only as needed — do not invent services the app does not use.
3. Ensure `.dockerignore`, non-root user, pinned base tags, multi-stage when useful.
4. Align with the stack: Node Express → compile TypeScript and CMD on `dist/`; C# → set `PROJECT` / `DLL` build args; Next → `output: 'standalone'` and `/health` if possible.
5. No secrets in the image or committed compose overrides. Use env files that stay gitignored.
6. Local deploy (builds once via compose, then `up --no-build`):

```bash
IMAGE=myapp:dev COMPOSE_FILE=compose.yml ./deploy/scripts/deploy.sh
```

7. If `/health` exists, keep Dockerfile/Compose healthchecks aligned with that path.
8. Document required env vars in a short comment or README section — do not invent production cloud deploy unless asked.
