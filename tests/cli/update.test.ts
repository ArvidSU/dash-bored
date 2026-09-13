import { expect, test } from "bun:test";

test('CLI rejects --yes alone and unsupported source installation', async () => {
  const run = async (args: string[]) => {
    const p = Bun.spawn([process.execPath, 'src/cli/index.ts', ...args], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
    return { code: await p.exited, error: await new Response(p.stderr).text() };
  };
  const yes = await run(['update', '--yes']); expect(yes.code).not.toBe(0); expect(yes.error).toContain('--yes alone does not authorize migration');
  const source = await run(['update', '--update-only']); expect(source.code).not.toBe(0); expect(source.error).toContain('source checkout');
});
