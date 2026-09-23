---
name: git-commit
description: >-
  Create a git commit from the current diff with a clear message and no secrets.
  Use when the user asks to commit, stage and commit, or write a commit message.
---

# Git commit

1. Run in parallel: `git status`, `git diff` (staged + unstaged), `git log -5 --oneline`.
2. Do not commit `.env`, credentials, or secret files. Warn if the user asks to include them.
3. Stage only relevant files. Follow the repo’s recent commit message style.
4. Prefer a short message focused on **why**, then commit via HEREDOC:

```bash
git commit -m "$(cat <<'EOF'
Short summary of why.

EOF
)"
```

5. Run `git status` after. Do not push unless asked. Do not amend unless the user requested it and safety rules allow.
6. Never skip hooks (`--no-verify`) unless the user explicitly asks.
