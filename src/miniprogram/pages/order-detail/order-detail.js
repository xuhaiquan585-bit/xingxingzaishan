const { login, redirectToBindPhone } = require('../../utils/auth');
const { request, resolveAssetUrl } = require('../../utils/request');

Page({
  data: {
    id: '',
    order: null,
    coverImage: '',
    message: '加载中...'
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
      return;
    }
    request({ url: `/api/miniapp/orders/${encodeURIComponent(this.data.id)}` }).then((order) => {
      this.setData({
        order,
        coverImage: resolveAssetUrl((order.product_snapshot || {}).cover_image),
        message: ''
      });
    }).catch((error) => {
      if (error.code === 'PHONE_NOT_BOUND') {
        redirectToBindPhone(`/pages/order-detail/order-detail?id=${encodeURIComponent(this.data.id)}`);
        return;
      }
      this.setData({ message: error.message || '加载失败，请稍后重试' });
    });
  },

  cancelOrder() {
    request({
      url: `/api/miniapp/orders/${encodeURIComponent(this.data.id)}/cancel`,
      method: 'POST'
    }).then((order) => {
      wx.showToast({ title: '订单已取消', icon: 'success' });
      this.setData({ order });
    }).catch((error) => {
      this.setData({ message: error.message || '取消失败' });
    });
  }
});
