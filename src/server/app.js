const express = require('express');
const path = require('path');
const { initializeDB } = require('./services/dbService');

const userRoutes = require('./routes/user');
const qrRoutes = require('./routes/qr');
const uploadRoutes = require('./routes/upload');
const adminRoutes = require('./routes/admin');
const qcRoutes = require('./routes/qc');
const nftRoutes = require('./routes/nft');
const { createRateLimiter } = require('./middlewares/rateLimit');
const { auditLogger } = require('./middlewares/auditLogger');
const { assertRuntimeConfig, parseOrigins } = require('./services/configService');

function corsMiddleware() {
  const allowedOrigins = new Set(parseOrigins(process.env.CORS_ORIGINS));
  const allowMethods = 'GET,POST,PUT,PATCH,DELETE,OPTIONS';
  const allowHeaders = 'Content-Type,Authorization';

  return (req, res, next) => {
    const origin = req.headers.origin;
    if (!origin) {
      return next();
    }

    if (!allowedOrigins.has(origin)) {
      if (req.method === 'OPTIONS') {
        return res.status(403).json({
          status: 'error',
          code: 'CORS_FORBIDDEN',
          message: '当前来源不被允许访问该接口。'
        });
      }
      return next();
    }

    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', allowMethods);
    res.setHeader('Access-Control-Allow-Headers', allowHeaders);

    if (req.method === 'OPTIONS') {
      return res.status(204).end();
    }

    return next();
  };
}

function createApp() {
  assertRuntimeConfig();

  const app = express();

  initializeDB();

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(corsMiddleware());


  const loginRateLimiter = createRateLimiter({
    window_ms: process.env.RATE_LIMIT_LOGIN_WINDOW_MS || 60_000,
    max_requests: process.env.RATE_LIMIT_LOGIN_MAX || 20,
    key_builder: (req) => {
      const identity = (req.body.phone || req.body.username || '').toString().trim();
      const keys = [`${req.ip}:login`];
      if (identity) {
        keys.push(`${identity}:login`);
      }
      return keys;
    },
    methods: ['POST']
  });

  const writeRateLimiter = createRateLimiter({
    window_ms: process.env.RATE_LIMIT_WRITE_WINDOW_MS || 60_000,
    max_requests: process.env.RATE_LIMIT_WRITE_MAX || 120,
    key_builder: (req) => `${req.ip}:write`,
    methods: ['POST', 'PUT', 'PATCH', 'DELETE']
  });

  app.use('/uploads', express.static(path.join(__dirname, 'public', 'uploads')));
  app.use('/cloud', express.static(path.join(__dirname, 'public', 'cloud')));
  // /qrcodes 已关闭公开访问，改为通过 /api/qr-image/:token 认证访问
  app.use(express.static(path.join(__dirname, '..', 'frontend')));
  app.use('/admin', express.static(path.join(__dirname, '..', 'admin')));
  app.use('/qc', express.static(path.join(__dirname, '..', 'qc')));

  app.get('/', (_req, res) => {
    res.sendFile(path.join(__dirname, '..', 'frontend', 'index.html'));
  });

  app.get('/admin', (_req, res) => {
    res.sendFile(path.join(__dirname, '..', 'admin', 'index.html'));
  });

  app.use(auditLogger());

  app.get('/qc', (_req, res) => {
    res.sendFile(path.join(__dirname, '..', 'qc', 'index.html'));
  });

  app.use('/api/user/login', loginRateLimiter);
  app.use('/api/admin/login', loginRateLimiter);
  app.use('/api/upload', writeRateLimiter);
  app.use('/api/qr', writeRateLimiter);

  app.use('/api/user', userRoutes);
  app.use('/api/qr', qrRoutes);
  app.use('/api/upload', uploadRoutes);
  app.use('/api/admin', adminRoutes);
  app.use('/api/qc', qcRoutes);
  app.use('/api/nft', nftRoutes);

  app.use((err, _req, res, _next) => {
    if (err.message === '仅支持图片文件上传') {
      return res.status(400).json({
        status: 'error',
        code: 'UPLOAD_FAILED',
        message: '仅支持图片格式，请重新选择。'
      });
    }

    return res.status(500).json({
      status: 'error',
      code: 'INTERNAL_ERROR',
      message: '系统开小差了，请稍后再试。'
    });
  });

  return app;
}

module.exports = {
  createApp
};
