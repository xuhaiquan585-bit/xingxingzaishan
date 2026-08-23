const MAX_ORDER_QUANTITY = 99;

function resolveQuantityLimit(product) {
  const configuredLimit = Math.floor(Number((product && product.stock) || 0));
  if (!Number.isFinite(configuredLimit) || configuredLimit < 1) {
    return MAX_ORDER_QUANTITY;
  }
  return Math.min(MAX_ORDER_QUANTITY, configuredLimit);
}

function normalizeQuantity(value, limit = MAX_ORDER_QUANTITY) {
  const normalizedLimit = Math.max(1, Math.min(MAX_ORDER_QUANTITY, Math.floor(Number(limit) || MAX_ORDER_QUANTITY)));
  const number = Math.floor(Number(value));
  if (!Number.isFinite(number)) return 1;
  return Math.max(1, Math.min(normalizedLimit, number));
}

function calculateTotalText(priceCents, quantity) {
  const cents = Math.max(0, Math.round(Number(priceCents) || 0));
  return `¥${((cents * normalizeQuantity(quantity)) / 100).toFixed(2)}`;
}

module.exports = {
  MAX_ORDER_QUANTITY,
  resolveQuantityLimit,
  normalizeQuantity,
  calculateTotalText
};
