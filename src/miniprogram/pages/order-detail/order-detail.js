const { login, redirectToBindPhone } = require('../../utils/auth');
const { request, resolveAssetUrl } = require('../../utils/request');
const { payMiniappOrder, isPaymentCancelled } = require('../../utils/payment');

function maskPhone(phone) {
  const value = String(phone || '');
  return /^1\d{10}$/.test(value) ? `${value.slice(0, 3)}****${value.slice(-4)}` : value;
}

function formatOrderTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (part) => String(part).padStart(2, '0');
  return `${date.getFullYear()}.${pad(date.getMonth() + 1)}.${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

Page({
  data: {
    id: '',
    order: null,
    coverImage: '',
    coverFailed: false,
    receiverPhoneText: '',
    orderTimeText: '',
    message: '加载中...',
    paying: false,
    cancelling: false
  },

  onLoad(options) {
    this.setData({ id: options.id || '' });
    login().then(() => this.loadOrder()).catch((error) => {
      this.setData({ message: error.message || '登录失败，请稍后重试' });
    });
  },

  loadOrder() {
    if (!this.data.id) {
      this.setData({ message: '缺少订单编号' });
      return Promise.resolve(null);
    }
    return request({ url: `/api/miniapp/orders/${encodeURIComponent(this.data.id)}` }).then((order) => {
      this.setData({
        order,
        coverImage: resolveAssetUrl((order.product_snapshot || {}).cover_image),
        coverFailed: false,
        receiverPhoneText: maskPhone(order.receiver_phone),
        orderTimeText: formatOrderTime(order.created_at),
        message: ''
      });
      return order;
    }).catch((error) => {
      if (error.code === 'PHONE_NOT_BOUND') {
        redirectToBindPhone(`/pages/order-detail/order-detail?id=${encodeURIComponent(this.data.id)}`);
        return null;
      }
      this.setData({ message: error.message || '加载失败，请稍后重试' });
      return null;
    });
  },

  onCoverError() {
    this.setData({ coverFailed: true });
  },

  continuePayment() {
    if (this.data.paying || !this.data.order || this.data.order.status !== 'pending_payment') return;
    this.setData({ paying: true, message: '' });
    payMiniappOrder(this.data.id).then(() => {
      wx.showToast({ title: '支付已完成', icon: 'success' });
      setTimeout(() => this.loadOrder().then(() => this.setData({ paying: false })), 600);
    }).catch((error) => {
      if (isPaymentCancelled(error)) {
        wx.showToast({ title: '已取消支付', icon: 'none' });
        this.setData({ paying: false });
        return;
      }
      this.setData({ paying: false, message: error.message || '支付未完成，请稍后重试' });
    });
  },

  cancelOrder() {
    if (this.data.cancelling) return;
    this.setData({ cancelling: true, message: '' });
    request({
      url: `/api/miniapp/orders/${encodeURIComponent(this.data.id)}/cancel`,
      method: 'POST'
    }).then((order) => {
      wx.showToast({ title: '订单已取消', icon: 'success' });
      this.setData({ order, cancelling: false });
    }).catch((error) => {
      this.setData({ cancelling: false, message: error.message || '取消失败' });
    });
  },

  copyExpress() {
    const expressNo = String((this.data.order && this.data.order.express_no) || '');
    if (!expressNo) return;
    wx.setClipboardData({ data: expressNo });
  },

  goProducts() {
    wx.switchTab({ url: '/pages/products/products' });
  }
});
