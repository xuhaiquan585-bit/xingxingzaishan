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
<<<<<<< HEAD
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

=======
    const keyResult = keyBuilder(req);
    const keys = Array.isArray(keyResult) ? keyResult : [keyResult];
    const now = Date.now();
    let smallestRemaining = maxRequests;
    let nearestResetAt = now + windowMs;

    for (const key of keys) {
      const normalizedKey = String(key || 'unknown');
      const bucket = store.get(normalizedKey);

      if (!bucket || now > bucket.resetAt) {
        store.set(normalizedKey, { count: 1, resetAt: now + windowMs });
        smallestRemaining = Math.min(smallestRemaining, maxRequests - 1);
        nearestResetAt = Math.min(nearestResetAt, now + windowMs);
        continue;
      }

      bucket.count += 1;
      smallestRemaining = Math.min(smallestRemaining, Math.max(0, maxRequests - bucket.count));
      nearestResetAt = Math.min(nearestResetAt, bucket.resetAt);

      if (bucket.count > maxRequests) {
        const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
        res.setHeader('Retry-After', String(retryAfterSeconds));
        res.setHeader('X-RateLimit-Limit', String(maxRequests));
        res.setHeader('X-RateLimit-Remaining', '0');
        res.setHeader('X-RateLimit-Reset', String(Math.floor(bucket.resetAt / 1000)));
        return res.status(429).json({
          status: 'error',
          code: 'RATE_LIMITED',
          message: '请求过于频繁，请稍后再试。'
        });
      }
    }

    res.setHeader('X-RateLimit-Limit', String(maxRequests));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, smallestRemaining)));
    res.setHeader('X-RateLimit-Reset', String(Math.floor(nearestResetAt / 1000)));
>>>>>>> origin/codex/review-task-document-for-understanding-tsjiat
    return next();
  };
}

module.exports = {
  createRateLimiter
};
