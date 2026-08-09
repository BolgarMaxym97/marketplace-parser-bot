import { cleanupSeen } from './cleanup';
import type { Env } from './config';
import { pollSources } from './poller';
import { handleWebhook } from './telegram/webhook';

const CLEANUP_CRON = '0 3 * * *';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/webhook' && request.method === 'POST') {
      return handleWebhook(request, env);
    }
    if (url.pathname === '/health') {
      return new Response('ok');
    }
    return new Response('not found', { status: 404 });
  },

  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const task = event.cron === CLEANUP_CRON ? cleanupSeen(env) : pollSources(env);
    ctx.waitUntil(
      task.then(
        () => undefined,
        (error) => console.error(`scheduled ${event.cron} failed`, error),
      ),
    );
  },
} satisfies ExportedHandler<Env>;
