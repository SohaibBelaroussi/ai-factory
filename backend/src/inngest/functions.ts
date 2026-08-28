import { NonRetriableError } from 'inngest';
import { inngest } from './client.js';
import { EVT, type StepFinishedData } from '../domain/types.js';
import * as ops from '../modules/runnerOps.js';

/**
 * The Pipeline Runner: one Inngest durable function per run. Control flow
 * only — provision → waitForEvent → validate → next/retry. It NEVER runs a
 * harness session in-function (dispatch-and-wait always), and every domain
 * transition is written to the Status DB as it happens.
 */
const runPipeline = inngest.createFunction(
  {
    id: 'run-pipeline',
    retries: 2,
    cancelOn: [{ event: EVT.runCancelled, match: 'data.runId' }],
    onFailure: async ({ event }) => {
      // Runner crashed after exhausting retries: don't leave the run dangling.
      const runId = (event.data.event.data as { runId?: string }).runId;
      if (!runId) return;
      const run = await ops.loadRun(runId);
      if (run && ['running', 'waiting-human'].includes(run.status)) {
        await ops.failRun(run, 'runner error (see backend logs)');
      }
    },
  },
  { event: EVT.runRequested },
  async ({ event, step }) => {
    const { runId } = event.data as { runId: string };

    const run = await step.run('load-run', async () => {
      const r = await ops.loadRun(runId);
      if (!r) throw new NonRetriableError(`run ${runId} not found`);
      return r;
    });
    if (run.status !== 'running') return { status: run.status, note: 'not in running state' };

    await step.run('prepare-run', () => ops.prepareRun(run));

    const steps = run.definition_snapshot.steps;
    const attempts: Record<number, number> = {};
    const rejections: Record<number, number> = {};
    let feedback: string | null = null;
    let i = 0;

    while (i < steps.length) {
      const sd = steps[i]!;
      attempts[i] = (attempts[i] ?? 0) + 1;
      const a = attempts[i]!;

      let prov = await step.run(`provision-s${i}-a${a}`, () =>
        ops.provisionStep(run, sd, a, feedback),
      );

      let evt = await step.waitForEvent(`wait-s${i}-a${a}`, {
        event: EVT.stepFinished,
        timeout: `${sd.timeoutMinutes + 3}m`,
        if: `async.data.stepRunId == "${prov.stepRunId}"`,
      });

      // ask_human: the worker suspended itself. Nothing runs and nothing
      // costs money until the answer; then a fresh worker resumes the same
      // session. Multi-turn approve/iterate loops are repeated cycles here.
      let r = 0;
      while (evt && (evt.data as StepFinishedData).outcome === 'waiting_human') {
        r += 1;
        await step.run(`suspend-s${i}-a${a}-r${r}`, () => ops.suspendStepCleanup(prov));
        const questionId = (evt.data as StepFinishedData & { questionId?: string }).questionId;
        const ans = await step.waitForEvent(`answer-s${i}-a${a}-r${r}`, {
          event: EVT.questionAnswered,
          timeout: '30d',
          if: `async.data.questionId == "${questionId}"`,
        });
        if (ans === null) {
          evt = null; // unanswered for 30 days → treated like a timeout below
          break;
        }
        prov = await step.run(`resume-s${i}-a${a}-r${r}`, () =>
          ops.resumeStep(run, sd, prov.stepRunId, (ans.data as { answer: string }).answer, r),
        );
        evt = await step.waitForEvent(`wait-s${i}-a${a}-r${r}`, {
          event: EVT.stepFinished,
          timeout: `${sd.timeoutMinutes + 3}m`,
          if: `async.data.stepRunId == "${prov.stepRunId}"`,
        });
      }

      const outcome = await step.run(`finalize-s${i}-a${a}`, () =>
        ops.finalizeStep(run, sd, prov, evt ? (evt.data as StepFinishedData) : null, a),
      );

      if (outcome.kind === 'cancelled') return { status: 'cancelled' };

      if (outcome.kind === 'failed') {
        await step.run(`fail-run-s${i}-a${a}`, () =>
          ops.failRun(run, outcome.reason, outcome.authFailure),
        );
        await step.sendEvent(`emit-failed-s${i}-a${a}`, {
          name: EVT.runFailed,
          data: { runId, reason: outcome.reason },
        });
        return { status: 'failed', reason: outcome.reason };
      }

      if (outcome.kind === 'reject') {
        // Re-run the PREVIOUS step with the rejection appended, if it has budget.
        const prevIdx = i - 1;
        const budget = prevIdx >= 0 ? (steps[prevIdx]!.retryWithFeedback ?? 0) : 0;
        const used = rejections[prevIdx] ?? 0;
        if (prevIdx >= 0 && used < budget) {
          rejections[prevIdx] = used + 1;
          feedback = outcome.feedback;
          i = prevIdx;
          continue;
        }
        const reason = `rejected with no retry budget left: ${outcome.feedback}`;
        await step.run(`fail-run-s${i}-a${a}`, () => ops.failRun(run, reason));
        await step.sendEvent(`emit-failed-s${i}-a${a}`, {
          name: EVT.runFailed,
          data: { runId, reason },
        });
        return { status: 'failed', reason };
      }

      // done → next step
      feedback = null;
      i += 1;
    }

    await step.run('complete-run', () => ops.completeRun(run));
    await step.sendEvent('emit-completed', { name: EVT.runCompleted, data: { runId } });
    return { status: 'completed' };
  },
);

const ping = inngest.createFunction(
  { id: 'factory-ping' },
  { event: 'factory/ping' },
  async () => ({ ok: true }),
);

/** Once-a-minute tick that fires due cron schedules (idempotent per minute bucket). */
const cronTick = inngest.createFunction(
  { id: 'factory-cron-tick', retries: 0 },
  { cron: '* * * * *' },
  async () => {
    const { fireDueSchedules } = await import('../modules/triggers.js');
    return fireDueSchedules(new Date());
  },
);

export const functions = [runPipeline, ping, cronTick];
