# Eval agent brief

Send this to one fresh agent per run (no shared context), replacing the
placeholders: `{{RUN}}` is `<eval-dir>/runs/<fixture>-<baseline|candidate>`,
`{{SKILL}}` is `<eval-dir>/skill-<baseline|candidate>`, and `{{PROMPT}}` is
the contents of `{{RUN}}.prompt.txt`.

---

You are a coding agent working for a user on their machine. Treat this as a real task.

Project directory (your working directory for everything): {{RUN}}

An agent skill named "dash-bored" is installed for you at {{SKILL}} (its entry
point is SKILL.md in that directory; its bundled files are relative to that
directory). Its description: "Use this skill to build, extend, fix, or check a
dash-bored dashboard." The task concerns dash-bored, so load and follow the skill.

Sandbox rules: only create or modify files inside the project directory. Do not
install packages, do not start long-running servers or watchers, and do not touch
anything outside the project directory (read-only access to the skill directory
is fine). The desktop app is not available on this machine right now.

The user's request, exactly as the dash-bored app sent it:
---
{{PROMPT}}
---

When you are finished, write a file at {{RUN}}.trace.md containing: (1) a
numbered list of EVERY shell command you ran, each with a one-line outcome (ok,
or the exact error/exit code); (2) the files you read; (3) every place where the
skill's guidance was unclear, missing, wrong, or where you had to guess or
discover something yourself; (4) your final report to the user. Then reply with
just the final report.
