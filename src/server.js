import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createSession, getSession, getSnapshot, setSessionStatus } from './sessions/manager.js';
import { startMock, stopMock } from './mock/generator.js';
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

  app.post('/api/sessions/:id/end', async (req, res, next) => {
    try {
      const session = await setSessionStatus(req.params.id, 'ended');
      if (!session) return res.status(404).json({ error: 'not found' });
      stopMock(req.params.id);
      res.json(session);
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
