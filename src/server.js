import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createSession, getSession, getSnapshot, setSessionStatus } from './sessions/manager.js';
import { startMock, stopMock } from './mock/generator.js';
import { startSessionPipeline } from './pipeline/session.js';
import { stopPipeline } from './pipeline/runtime.js';
import { getTranscriptTail } from './pipeline/transcript.js';
import { getSpeakers } from './pipeline/speakers.js';
import { handleChatMessage } from './pipeline/chatCommands.js';
import { logger } from './logger.js';

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = join(here, '..', 'public');

export function createApp() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.get('/healthz', (_req, res) => res.json({ ok: true, uptime: process.uptime() }));

  app.post('/api/sessions', async (req, res, next) => {
    try {
      const { meetingUrl, config = {}, speakers = [], motion = '', mock = false } = req.body || {};
      const session = await createSession({ meetingUrl, config, speakers, motion });
      if (mock) startMock(session.id);
      res.status(201).json(session);
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/sessions/:id', async (req, res, next) => {
    try {
      const session = await getSession(req.params.id);
      if (!session) return res.status(404).json({ error: 'not found' });
      res.json(session);
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/sessions/:id/snapshot', async (req, res, next) => {
    try {
      const snapshot = await getSnapshot(req.params.id);
      if (!snapshot) return res.status(404).json({ error: 'not found' });
      res.json(snapshot);
    } catch (err) {
      next(err);
    }
  });

  // "Send bot": start the live pipeline (meeting provider joins the call).
  app.post('/api/sessions/:id/start', async (req, res, next) => {
    try {
      const result = await startSessionPipeline(req.params.id);
      res.json({ ok: true, ...result });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/sessions/:id/end', async (req, res, next) => {
    try {
      await stopPipeline(req.params.id);
      const session = await setSessionStatus(req.params.id, 'ended');
      if (!session) return res.status(404).json({ error: 'not found' });
      stopMock(req.params.id);
      res.json(session);
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/sessions/:id/transcript', async (req, res, next) => {
    try {
      const session = await getSession(req.params.id);
      if (!session) return res.status(404).json({ error: 'not found' });
      const count = Math.min(parseInt(req.query.count || '100', 10), 500);
      res.json({ entries: await getTranscriptTail(req.params.id, count) });
    } catch (err) {
      next(err);
    }
  });

  // Host-dashboard command entry point — same registry as in-call chat commands.
  app.post('/api/sessions/:id/command', async (req, res, next) => {
    try {
      const session = await getSession(req.params.id);
      if (!session) return res.status(404).json({ error: 'not found' });
      const { name, args = [] } = req.body || {};
      if (!name) return res.status(400).json({ error: 'name is required' });
      const handled = await handleChatMessage(req.params.id, {
        participantId: 'dashboard',
        name: 'Host dashboard',
        text: `/${name} ${args.join(' ')}`.trim(),
      });
      res.json({ ok: true, handled });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/sessions/:id/speakers', async (req, res, next) => {
    try {
      const session = await getSession(req.params.id);
      if (!session) return res.status(404).json({ error: 'not found' });
      res.json({ speakers: await getSpeakers(req.params.id) });
    } catch (err) {
      next(err);
    }
  });

  // Argument graph (claims + verdict state) — feeds stage mode + dashboards.
  app.get('/api/sessions/:id/claims', async (req, res, next) => {
    try {
      const session = await getSession(req.params.id);
      if (!session) return res.status(404).json({ error: 'not found' });
      const { getClaims } = await import('./pipeline/argumentGraph.js');
      res.json({ claims: await getClaims(req.params.id) });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/sessions/:id/mock', async (req, res, next) => {
    try {
      const session = await getSession(req.params.id);
      if (!session) return res.status(404).json({ error: 'not found' });
      const action = req.body?.action || 'start';
      if (action === 'start') startMock(req.params.id);
      else stopMock(req.params.id);
      res.json({ ok: true, action });
    } catch (err) {
      next(err);
    }
  });

  // Product surfaces (served by the backend; SPEC §4.1)
  app.use('/display', express.static(join(publicDir, 'display')));
  app.use('/dashboard', express.static(join(publicDir, 'dashboard')));
  app.use('/stage', express.static(join(publicDir, 'stage')));
  app.use('/launcher', express.static(join(publicDir, 'launcher')));
  app.use('/shared', express.static(join(publicDir, 'shared')));
  app.get('/', (_req, res) => res.redirect('/launcher/'));

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    const status = err.status || 500;
    if (status >= 500) logger.error('request failed', { error: err.message, stack: err.stack });
    res.status(status).json({ error: err.message });
  });

  return app;
}
