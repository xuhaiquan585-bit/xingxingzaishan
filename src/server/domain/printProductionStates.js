'use strict';

const TEMPLATE_STATUSES = Object.freeze(['draft', 'published', 'archived']);
const TEMPLATE_VERSION_STATUSES = Object.freeze(['draft', 'published']);
const PRINT_BATCH_STATUSES = Object.freeze([
  'reserved',
  'generating',
  'generation_failed',
  'artifact_ready',
  'printing',
  'completed',
  'canceled',
  'voided'
]);
const QR_PRINT_STATUSES = Object.freeze([
  'legacy_unclassified',
  'available',
  'reserved',
  'artifact_generated',
  'printed',
  'voided'
]);

const PRINT_BATCH_TRANSITIONS = Object.freeze({
  reserved: Object.freeze(['generating', 'canceled']),
  generating: Object.freeze(['artifact_ready', 'generation_failed']),
  generation_failed: Object.freeze(['generating', 'canceled']),
  artifact_ready: Object.freeze(['printing', 'voided']),
  printing: Object.freeze(['completed', 'voided']),
  completed: Object.freeze([]),
  canceled: Object.freeze([]),
  voided: Object.freeze([])
});

const QR_PRINT_TRANSITIONS = Object.freeze({
  legacy_unclassified: Object.freeze(['available', 'voided']),
  available: Object.freeze(['reserved']),
  reserved: Object.freeze(['available', 'artifact_generated']),
  artifact_generated: Object.freeze(['printed', 'voided']),
  printed: Object.freeze([]),
  voided: Object.freeze([])
});

function canTransition(table, from, to) {
  return from === to || Boolean(table[from] && table[from].includes(to));
}

function canTransitionPrintBatch(from, to) {
  return canTransition(PRINT_BATCH_TRANSITIONS, from, to);
}

function canTransitionQrPrint(from, to) {
  return canTransition(QR_PRINT_TRANSITIONS, from, to);
}

module.exports = {
  PRINT_BATCH_STATUSES,
  PRINT_BATCH_TRANSITIONS,
  QR_PRINT_STATUSES,
  QR_PRINT_TRANSITIONS,
  TEMPLATE_STATUSES,
  TEMPLATE_VERSION_STATUSES,
  canTransitionPrintBatch,
  canTransitionQrPrint
};
