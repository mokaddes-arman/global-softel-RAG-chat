'use strict';

const path = require('node:path');
const fs = require('node:fs');
const express = require('express');
const cors = require('cors');

const { config } = require('./config/env');
const { logger } = require('./lib/logger');
const { requestContext } = require('./middleware/requestContext');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');

const healthRoutes = require('./routes/health');
const projectRoutes = require('./routes/projects');
const documentRoutes = require('./routes/documents');
const knowledgeRoutes = require('./routes/knowledge');
const conversationRoutes = require('./routes/conversations');
const providerRoutes = require('./routes/providers');
const settingsRoutes = require('./routes/settings');
const usageRoutes = require('./routes/usage');

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);

  // Narrow CORS: only the configured dev/preview origins may call the API.
  const allowed = new Set(config.corsOrigins);
  app.use(
    cors({
      origin(origin, callback) {
        if (!origin) return callback(null, true); // same-origin / curl / server-side
        if (allowed.has(origin)) return callback(null, true);
        return callback(null, false);
      },
      credentials: false,
      methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['content-type', 'authorization', 'x-request-id', 'accept'],
    }),
  );

  // Baseline hardening for every response.
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    next();
  });

  app.use(requestContext);
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: false, limit: '2mb' }));

  // Simple, cheap request shaping for uploads and generation endpoints.
  app.use((req, res, next) => {
    if (req.path.includes('/upload') || req.path.includes('/messages')) {
      res.setTimeout(10 * 60 * 1000); // uploads + long generations
    }
    next();
  });

  // Routers define their own full sub-paths, except the projects router whose
  // routes are relative to the project collection (`/`, `/:id`, `/:id/...`).
  app.use('/api', healthRoutes);
  app.use('/api', providerRoutes);
  app.use('/api', settingsRoutes);
  app.use('/api', usageRoutes);
  app.use('/api/projects', projectRoutes);
  app.use('/api', documentRoutes);
  app.use('/api', knowledgeRoutes);
  app.use('/api', conversationRoutes);

  // Serve the built SPA when it exists (production / `npm run build`).
  const distDir = path.resolve(config.projectRoot, 'web', 'dist');
  if (fs.existsSync(path.join(distDir, 'index.html'))) {
    app.use(express.static(distDir, { index: false, maxAge: '1h' }));
    app.use((req, res, next) => {
      if (req.method !== 'GET' || req.path.startsWith('/api')) return next();
      return res.sendFile(path.join(distDir, 'index.html'));
    });
    logger.info({ distDir }, 'serving built frontend');
  }

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
