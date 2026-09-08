import { expect, test } from "bun:test";

test('CLI rejects --yes alone, unavailable channels, and unsupported source installation', async () => {
  const run = async (args: string[]) => {
    const p = Bun.spawn([process.execPath, 'src/cli/index.ts', ...args], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
    return { code: await p.exited, error: await new Response(p.stderr).text() };
  };
  const yes = await run(['update', '--yes']); expect(yes.code).not.toBe(0); expect(yes.error).toContain('--yes alone does not authorize migration');
  const beta = await run(['update', 'settings', '--channel', 'beta']); expect(beta.code).not.toBe(0); expect(beta.error).toContain('Only Canary');
  const source = await run(['update', '--update-only']); expect(source.code).not.toBe(0); expect(source.error).toContain('source checkout');
});
