import type { FastifyInstance } from 'fastify';
import {
  listPipelines,
  getPipeline,
  createPipeline,
  updatePipeline,
  disablePipeline,
} from '../../modules/pipelines.js';
import type { PipelineDefinition } from '../../domain/types.js';

export async function pipelinesRoutes(app: FastifyInstance): Promise<void> {
  app.get('/pipelines', async () => listPipelines());

  app.get<{ Params: { id: string } }>('/pipelines/:id', async (req, reply) => {
    const def = await getPipeline(req.params.id);
    if (!def) return reply.code(404).send({ error: { code: 'not_found', message: 'no such pipeline' } });
    return def;
  });

  app.post<{
    Body: {
      name?: string;
      description?: string;
      inputSchema?: PipelineDefinition['inputSchema'];
      steps?: unknown;
    };
  }>('/pipelines', async (req, reply) => {
    const { name, description, inputSchema, steps } = req.body ?? {};
    if (!name?.trim() || !description?.trim() || !steps) {
      return reply.code(422).send({
        error: { code: 'validation', message: 'Body must include {name, description, steps[]}' },
      });
    }
    try {
      const def = await createPipeline({
        name: name.trim(),
        description: description.trim(),
        inputSchema: inputSchema ?? { brief: 'required' },
        steps,
      });
      return reply.code(201).send(def);
    } catch (err) {
      return reply.code(422).send({ error: { code: 'validation', message: String(err) } });
    }
  });

  app.put<{
    Params: { id: string };
    Body: {
      description?: string;
      inputSchema?: PipelineDefinition['inputSchema'];
      steps?: unknown;
    };
  }>('/pipelines/:id', async (req, reply) => {
    try {
      const def = await updatePipeline(req.params.id, req.body ?? {});
      if (!def) return reply.code(404).send({ error: { code: 'not_found', message: 'no such pipeline' } });
      return def;
    } catch (err) {
      return reply.code(422).send({ error: { code: 'validation', message: String(err) } });
    }
  });

  app.post<{ Params: { id: string } }>('/pipelines/:id/disable', async (req, reply) => {
    const def = await getPipeline(req.params.id);
    if (!def) return reply.code(404).send({ error: { code: 'not_found', message: 'no such pipeline' } });
    await disablePipeline(def.id);
    return { disabled: true };
  });
}
