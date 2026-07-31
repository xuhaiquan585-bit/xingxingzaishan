'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SAFE_ENDPOINTS = new Set(['/api/qr/:key', '/api/miniapp/qr/:key']);
const FILE_PREFIX = 'public-qr-shadow-';

function boundedString(value, maxLength = 160) {
  return String(value || '').replace(/[\r\n\0]/g, '').slice(0, maxLength);
}

function safeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function sanitizeMismatchRecord(input = {}, { now = new Date(), randomUUID = crypto.randomUUID } = {}) {
  const endpoint = SAFE_ENDPOINTS.has(input.endpoint_template)
    ? input.endpoint_template
    : 'unknown';
  const record = {
    timestamp: now.toISOString(),
    observation_id: randomUUID(),
    endpoint_template: endpoint,
    channel: input.channel === 'miniapp' ? 'miniapp' : 'h5',
    lifecycle: boundedString(input.lifecycle, 32),
    field_path: boundedString(input.field_path, 240),
    difference_type: boundedString(input.difference_type, 80),
    baseline_type: boundedString(input.baseline_type, 24),
    candidate_type: boundedString(input.candidate_type, 24),
    outcome: boundedString(input.outcome, 80),
    latency_bucket: boundedString(input.latency_bucket, 32),
    observer_version: boundedString(input.observer_version, 64)
  };
  for (const field of ['baseline_count', 'candidate_count', 'mismatch_count']) {
    const number = safeInteger(input[field]);
    if (number !== undefined) record[field] = number;
  }
  if (input.truncated === true) record.truncated = true;
  return record;
}

class PublicQrMismatchSink {
  constructor({
    directory,
    maxBytes = 5 * 1024 * 1024,
    retentionDays = 14,
    queueLimit = 100,
    now = () => new Date(),
    fsPromises = fs.promises,
    onError = () => {}
  } = {}) {
    if (!directory || !path.isAbsolute(directory)) {
      throw new Error('PUBLIC_QR_SHADOW_SINK_DIRECTORY_REQUIRED');
    }
    this.directory = path.resolve(directory);
    this.maxBytes = maxBytes;
    this.retentionDays = retentionDays;
    this.queueLimit = queueLimit;
    this.now = now;
    this.fs = fsPromises;
    this.onError = onError;
    this.queue = [];
    this.draining = null;
    this.lastCleanupDay = '';
    this.dropped = 0;
  }

  enqueue(input) {
    if (this.queue.length >= this.queueLimit) {
      this.dropped += 1;
      const error = new Error('PUBLIC_QR_SHADOW_SINK_QUEUE_FULL');
      error.code = 'PUBLIC_QR_SHADOW_SINK_QUEUE_FULL';
      this.onError(error);
      return { accepted: false, completion: Promise.resolve(false) };
    }

    let resolveCompletion;
    const completion = new Promise((resolve) => { resolveCompletion = resolve; });
    this.queue.push({ record: sanitizeMismatchRecord(input, { now: this.now() }), resolveCompletion });
    this.#startDrain();
    return { accepted: true, completion };
  }

  async flush() {
    while (this.draining) await this.draining;
  }

  #startDrain() {
    if (this.draining) return;
    this.draining = this.#drain().finally(() => {
      this.draining = null;
      if (this.queue.length > 0) this.#startDrain();
    });
  }

  async #drain() {
    while (this.queue.length > 0) {
      const item = this.queue.shift();
      try {
        await this.#write(item.record);
        item.resolveCompletion(true);
      } catch (error) {
        this.onError(error);
        item.resolveCompletion(false);
      }
    }
  }

  async #write(record) {
    await this.fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    await this.#cleanupExpired(record.timestamp.slice(0, 10));
    const activePath = path.join(this.directory, `${FILE_PREFIX}current.jsonl`);
    const line = `${JSON.stringify(record)}\n`;
    let currentSize = 0;
    try {
      currentSize = Number((await this.fs.stat(activePath)).size || 0);
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
    }
    if (currentSize > 0 && currentSize + Buffer.byteLength(line) > this.maxBytes) {
      const suffix = record.timestamp.replace(/[:.]/g, '-');
      await this.fs.rename(activePath, path.join(this.directory, `${FILE_PREFIX}${suffix}.jsonl`));
    }
    await this.fs.appendFile(activePath, line, { encoding: 'utf8', mode: 0o600 });
  }

  async #cleanupExpired(day) {
    if (this.lastCleanupDay === day) return;
    this.lastCleanupDay = day;
    const threshold = this.now().getTime() - (this.retentionDays * 24 * 60 * 60 * 1000);
    const entries = await this.fs.readdir(this.directory, { withFileTypes: true });
    await Promise.all(entries.map(async (entry) => {
      if (!entry.isFile() || !entry.name.startsWith(FILE_PREFIX)) return;
      const filePath = path.join(this.directory, entry.name);
      const stat = await this.fs.stat(filePath);
      if (stat.mtimeMs < threshold) await this.fs.unlink(filePath);
    }));
  }
}

module.exports = {
  FILE_PREFIX,
  PublicQrMismatchSink,
  SAFE_ENDPOINTS,
  sanitizeMismatchRecord
};
