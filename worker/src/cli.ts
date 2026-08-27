import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Pin the Claude Code executable explicitly — it resolves nondeterministically
 * otherwise (validated gotcha). SDK 0.3.x ships the CLI as a native binary in a
 * platform-specific sibling package (@anthropic-ai/claude-agent-sdk-<os>-<arch>).
 * Order: env override → sibling resolved from the SDK's own location → the
 * image's known layout (glibc, then musl).
 */
export function resolveClaudeExecutable(): string {
  const platformPkg = `claude-agent-sdk-${process.platform}-${process.arch}`;
  const candidates: string[] = [];

  if (process.env.CLAUDE_CODE_EXECUTABLE) candidates.push(process.env.CLAUDE_CODE_EXECUTABLE);
  try {
    const sdkEntry = import.meta.resolve('@anthropic-ai/claude-agent-sdk');
    candidates.push(fileURLToPath(new URL(`../${platformPkg}/claude`, sdkEntry)));
  } catch {
    // resolution not available; fall through to the fixed image paths
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
