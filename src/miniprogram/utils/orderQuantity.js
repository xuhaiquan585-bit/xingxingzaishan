const MAX_ORDER_QUANTITY = 99;

function resolveQuantityLimit(product) {
  const configuredLimit = Math.floor(Number((product && product.stock) || 0));
  const purchaseLimit = !Number.isFinite(configuredLimit) || configuredLimit < 1
    ? MAX_ORDER_QUANTITY
    : Math.min(MAX_ORDER_QUANTITY, configuredLimit);
  const inventoryCount = Math.max(0, Math.floor(Number((product && product.inventory_count) || 0)));
  return Math.min(purchaseLimit, inventoryCount);
}

function normalizeQuantity(value, limit = MAX_ORDER_QUANTITY) {
  const numericLimit = Math.floor(Number(limit));
  if (Number.isFinite(numericLimit) && numericLimit <= 0) return 0;
  const normalizedLimit = Math.max(1, Math.min(MAX_ORDER_QUANTITY, numericLimit || MAX_ORDER_QUANTITY));
  const number = Math.floor(Number(value));
  if (!Number.isFinite(number)) return 1;
  return Math.max(1, Math.min(normalizedLimit, number));
}

function calculateTotalText(priceCents, quantity) {
  const cents = Math.max(0, Math.round(Number(priceCents) || 0));
  if (Math.floor(Number(quantity)) <= 0) return '¥0.00';
  return `¥${((cents * normalizeQuantity(quantity)) / 100).toFixed(2)}`;
}

module.exports = {
  MAX_ORDER_QUANTITY,
  resolveQuantityLimit,
  normalizeQuantity,
  calculateTotalText
};
