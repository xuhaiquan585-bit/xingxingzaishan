const test = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveQuantityLimit,
  normalizeQuantity,
  calculateTotalText
} = require('../src/miniprogram/utils/orderQuantity');

test('quantity limit uses product single-order limit and keeps 99 as the unlimited UI cap', () => {
  assert.equal(resolveQuantityLimit({ stock: 1, inventory_count: 10 }), 1);
  assert.equal(resolveQuantityLimit({ stock: 10, inventory_count: 3 }), 3);
  assert.equal(resolveQuantityLimit({ stock: 0, inventory_count: 120 }), 99);
  assert.equal(resolveQuantityLimit({ stock: 0, inventory_count: 0 }), 0);
  assert.equal(resolveQuantityLimit({}), 0);
});

test('typed quantities replace the initial value and clamp to the product limit', () => {
  assert.equal(normalizeQuantity('2', 99), 2);
  assert.equal(normalizeQuantity('11', 99), 11);
  assert.equal(normalizeQuantity('22', 99), 22);
  assert.equal(normalizeQuantity('100', 99), 99);
  assert.equal(normalizeQuantity('2', 1), 1);
  assert.equal(normalizeQuantity('1', 0), 0);
});

test('payable total always uses authoritative cents and normalized quantity', () => {
  assert.equal(calculateTotalText(1, 1), '¥0.01');
  assert.equal(calculateTotalText(1, 10), '¥0.10');
  assert.equal(calculateTotalText(1, 99), '¥0.99');
  assert.equal(calculateTotalText(1, 0), '¥0.00');
});
