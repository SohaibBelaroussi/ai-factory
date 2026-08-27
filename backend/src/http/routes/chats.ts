import type { FastifyInstance } from 'fastify';
import { query } from '../../db/client.js';
import { runMasterTurn } from '../../master/service.js';

export async function chatsRoutes(app: FastifyInstance): Promise<void> {
  app.post('/chats', async (_req, reply) => {
    const res = await query<{ id: string }>(
      `insert into chat_conversations default values returning id`,
    );
    return reply.code(201).send({ chatId: res.rows[0]!.id });
  });

  app.get('/chats', async () => {
    const res = await query(
      `select id, title, sdk_session_id, created_at, last_message_at
       from chat_conversations order by last_message_at desc limit 100`,
    );
    return res.rows;
  });

  app.get<{ Params: { id: string } }>('/chats/:id/messages', async (req, reply) => {
    const conv = await query('select id from chat_conversations where id = $1', [req.params.id]);
    if (!conv.rows[0]) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'no such chat' } });
    }
    const res = await query(
      `select id, role, content, ts from chat_messages
       where conversation_id = $1 order by ts, id`,
      [req.params.id],
    );
    return res.rows;
  });

  /** User turn → SSE stream of the Master's response (tool-use events included). */
  app.post<{ Params: { id: string }; Body: { message?: string } }>(
    '/chats/:id/messages',
    async (req, reply) => {
      const message = req.body?.message;
      if (typeof message !== 'string' || message.trim() === '') {
        return reply.code(422).send({
          error: { code: 'validation', message: 'Body must be {"message": "<text>"}' },
        });
      }

      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      const send = (event: string, data: unknown): void => {
        reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      await runMasterTurn(req.params.id, message.trim(), (e) => {
        if (e.type === 'assistant') send('assistant', { text: e.text });
        else if (e.type === 'tool.use') send('tool.use', { name: e.name, input: e.input });
        else if (e.type === 'done') send('done', { sessionId: e.sessionId });
        else send('error', { message: e.message });
      });

      reply.raw.end();
      return reply;
    },
  );
}
