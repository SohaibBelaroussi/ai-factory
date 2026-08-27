import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Pin the Claude Code executable for the in-process Master sessions — same
 * rule as the worker: never let it resolve nondeterministically. SDK 0.3.x
 * ships the CLI as a native binary in a platform sibling package.
 */
export function resolveClaudeExecutable(): string {
  const platformPkg = `claude-agent-sdk-${process.platform}-${process.arch}`;
  const candidates: string[] = [];

  if (process.env.CLAUDE_CODE_EXECUTABLE) candidates.push(process.env.CLAUDE_CODE_EXECUTABLE);
  try {
    const sdkEntry = import.meta.resolve('@anthropic-ai/claude-agent-sdk');
    for (const suffix of ['claude', 'claude.exe']) {
      candidates.push(fileURLToPath(new URL(`../${platformPkg}/${suffix}`, sdkEntry)));
      candidates.push(fileURLToPath(new URL(`../${platformPkg}-musl/${suffix}`, sdkEntry)));
    }
  } catch {
    // fall through to fixed paths
  }
  candidates.push(
    `/app/node_modules/@anthropic-ai/${platformPkg}/claude`,
    `/app/node_modules/@anthropic-ai/${platformPkg}-musl/claude`,
  );

  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error(`Claude Code executable not found; tried: ${candidates.join(', ')}`);
}
