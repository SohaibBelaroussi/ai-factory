import Docker from 'dockerode';
import { config } from '../config.js';
import { query } from '../db/client.js';

/**
 * The ONLY privileged module — talks to the Docker API via the mounted socket
 * to spawn ephemeral worker containers on the factory network. Interface is
 * deliberately thin (start/kill/remove): the future seam for running workers
 * elsewhere.
 */

const docker = new Docker({ socketPath: config.dockerSocket });

export async function startWorker(args: {
  name: string;
  env: Record<string, string>;
}): Promise<string> {
  // Idempotency: a retried provision step may find the container already there.
  const existing = docker.getContainer(args.name);
  try {
    await existing.remove({ force: true });
  } catch {
    // didn't exist — the normal case
  }

  const container = await docker.createContainer({
    Image: config.workerImage,
    name: args.name,
    Env: Object.entries(args.env).map(([k, v]) => `${k}=${v}`),
    HostConfig: {
      NetworkMode: config.dockerNetwork,
      // No AutoRemove: the runner removes the container after capturing logs,
      // so a crash before the worker can report anything is still diagnosable.
    },
    Labels: { 'ai-factory': 'step-worker' },
  });
  await container.start();
  return container.id;
}

export async function killWorker(containerId: string): Promise<void> {
  try {
    await docker.getContainer(containerId).stop({ t: 5 });
  } catch {
    // already stopped or gone
  }
}

/**
 * Remove the container. If stepRunId is given, first capture the container's
 * last stdout/stderr lines into step_logs (diagnosis for crashes/timeouts).
 */
export async function removeWorker(containerId: string, stepRunId?: string): Promise<void> {
  const container = docker.getContainer(containerId);
  if (stepRunId) {
    try {
      const buf = (await container.logs({
        stdout: true,
        stderr: true,
        tail: 200,
      })) as unknown as Buffer;
      // Strip docker stream-frame headers / control bytes, keep tab + newline.
      const text = Array.from(buf.toString('utf8'))
        .filter((ch) => ch === '\t' || ch === '\n' || ch >= ' ')
        .join('');
      if (text.trim()) {
        await query('insert into step_logs (step_run_id, event) values ($1, $2)', [
          stepRunId,
          JSON.stringify({ type: 'container-logs', text: text.slice(-8000) }),
        ]);
      }
    } catch {
      // log capture is best-effort
    }
  }
  try {
    await container.remove({ force: true });
  } catch {
    // already removed
  }
}
