export const health = () => Response.json({ ok: true });
if (import.meta.main) Bun.serve({ port: 3000, fetch: health });
