function createRateLimiter(options = {}) {
  const windowMs = Number(options.window_ms || 60_000);
  const maxRequests = Number(options.max_requests || 60);
  const store = new Map();

  return (req, res, next) => {
    const methods = Array.isArray(options.methods) ? options.methods : null;
    if (methods && !methods.includes(req.method)) {
      return next();
    }
    const keyBuilder = options.key_builder || ((r) => r.ip || 'unknown');
    const key = keyBuilder(req);
    const now = Date.now();
    const bucket = store.get(key);

    if (!bucket || now > bucket.resetAt) {
      store.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }

    bucket.count += 1;
    if (bucket.count > maxRequests) {
      return res.status(429).json({
        status: 'error',
        code: 'RATE_LIMITED',
        message: '请求过于频繁，请稍后再试。'
      });
    }

    return next();
  };
}

module.exports = {
  createRateLimiter
};
