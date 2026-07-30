const { request } = require('./request');

function paymentError(error) {
  const original = error || new Error('支付未完成，请稍后重试');
  if (String(original.errMsg || '').toLowerCase().includes('cancel')) {
    original.code = 'PAYMENT_CANCELLED';
  }
  return original;
}

function requestWechatPayment(payment) {
  return new Promise((resolve, reject) => {
    wx.requestPayment({
      ...payment,
      success: resolve,
      fail: (error) => reject(paymentError(error))
    });
  });
}

function payMiniappOrder(orderId) {
  return request({
    url: `/api/miniapp/orders/${encodeURIComponent(orderId)}/pay`,
    method: 'POST'
  }).then((result) => {
    if (result.payment) {
      return requestWechatPayment(result.payment).then(() => ({
        order: result.order || null,
        paymentRequested: true
      }));
    }
    return {
      order: result.order || null,
      paymentRequested: Boolean(result.payment_mock)
    };
  });
}

function isPaymentCancelled(error) {
  return Boolean(error && error.code === 'PAYMENT_CANCELLED');
}

module.exports = {
  payMiniappOrder,
  isPaymentCancelled
};
