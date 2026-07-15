const express = require('express');
const {
  appendPaymentLog,
  getOrderByOrderNo,
  markOrderPaidByOrderNo
} = require('../services/dbService');
const {
  getConfig,
  parsePaymentNotify
} = require('../services/wechatPayService');

const router = express.Router();

function successResponse(res) {
  return res.status(200).json({ code: 'SUCCESS', message: '成功' });
}

function failResponse(res, message = '失败') {
  return res.status(400).json({ code: 'FAIL', message });
}

router.post('/wechat/notify', (req, res) => {
  const rawBody = req.rawBody || JSON.stringify(req.body || {});
  let notify = null;
  try {
    notify = parsePaymentNotify({
      rawBody,
      headers: req.headers
    });
  } catch (error) {
    appendPaymentLog({
      method: 'wechat',
      status: 'notify_rejected',
      error: error.code || error.message,
      raw: { message: error.message }
    });
    return failResponse(res, '验签失败');
  }

  const config = getConfig();
  const orderNo = notify.out_trade_no || '';
  const order = getOrderByOrderNo(orderNo);
  if (!order) {
    appendPaymentLog({
      order_no: orderNo,
      method: 'wechat',
      status: 'order_not_found',
      transaction_id: notify.transaction_id || '',
      raw: notify
    });
    return failResponse(res, '订单不存在');
  }
  if (notify.appid !== config.appid || notify.mchid !== config.mchid) {
    appendPaymentLog({
      order_id: order.id,
      order_no: order.order_no,
      method: 'wechat',
      status: 'identity_mismatch',
      transaction_id: notify.transaction_id || '',
      amount_cents: notify.amount && notify.amount.total,
      raw: notify
    });
    return failResponse(res, '商户信息不一致');
  }
  if (notify.trade_state !== 'SUCCESS') {
    appendPaymentLog({
      order_id: order.id,
      order_no: order.order_no,
      method: 'wechat',
      status: notify.trade_state || 'not_success',
      transaction_id: notify.transaction_id || '',
      amount_cents: notify.amount && notify.amount.total,
      raw: notify
    });
    return successResponse(res);
  }

  const paidResult = markOrderPaidByOrderNo({
    orderNo,
    transactionId: notify.transaction_id || '',
    paidAt: notify.success_time || new Date().toISOString(),
    raw: notify
  });
  if (paidResult.error === 'AMOUNT_MISMATCH') {
    appendPaymentLog({
      order_id: order.id,
      order_no: order.order_no,
      method: 'wechat',
      status: 'amount_mismatch',
      transaction_id: notify.transaction_id || '',
      amount_cents: notify.amount && notify.amount.total,
      raw: notify
    });
    return failResponse(res, '金额不一致');
  }
  if (paidResult.error) {
    return failResponse(res, '订单更新失败');
  }
  return successResponse(res);
});

module.exports = router;
