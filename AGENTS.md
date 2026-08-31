[IDEA.md](./IDEA.md) guides implementation, if plans, prompts, code or documentation etc. conflicts, stop and resolve the conflict by either changing IDEA.md to reflect a new or updated direction or adjust the plan, prompt, code or documentation.

[ARCHITECTURE.md](./ARCHITECTURE.md) Should guide, reflect and be kept up to date with actual implementation.

Dog food this project and its features by adding components with sane configurations in the project dashboard.

## Documentation ownership

Keep `AGENTS.md` intentionally small and agent-specific. Product intent belongs
in `IDEA.md`; implementation decisions, contracts, and invariants belong in
`ARCHITECTURE.md`; user-facing setup, commands, and workflows belong in
`README.md`. Do not duplicate any of those here. Before adding an AGENTS note,
first update the canonical document when needed, then add only a short,
verified agent-execution quirk that cannot reasonably live there.

## Agent-only UI verification

When Computer Use is available, native app interaction is the second UI-proof
layer. Call `get_app_state` for `dash-bored-dev`, verify that the accessible
header config path identifies this checkout, and operate only a harmless,
visible control through its current `element_index`. Re-read `get_app_state`
after each click, drag, tab switch, or window interaction because native
accessibility indices can become stale. Capture a native screenshot when visual
placement matters; accessibility state proves control wiring, not pixel layout.
Restore temporary UI state such as the sidebar or selected tab. Do not use a
smoke check to launch commands, edit YAML, change trust, or mutate user data.
If native control injection fails, report the exact missing interaction rather
than claiming native coverage.
