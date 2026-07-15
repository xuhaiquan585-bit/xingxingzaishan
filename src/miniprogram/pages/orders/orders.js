const { login, redirectToBindPhone } = require('../../utils/auth');
const { request, resolveAssetUrl } = require('../../utils/request');

Page({
  data: {
    orders: [],
    message: '加载中...'
  },

  onLoad() {
    login().then(() => this.loadOrders()).catch((error) => {
      this.setData({ message: error.message || '登录失败，请稍后重试' });
    });
  },

  onShow() {
    if (this.data.orders.length) this.loadOrders();
  },

  loadOrders() {
    request({ url: '/api/miniapp/orders' }).then((data) => {
      const orders = (data.orders || []).map((item) => ({
        ...item,
        cover_image: resolveAssetUrl((item.product_snapshot || {}).cover_image)
      }));
      this.setData({
        orders,
        message: orders.length ? '' : '还没有贴纸订单。'
      });
    }).catch((error) => {
      if (error.code === 'PHONE_NOT_BOUND') {
        redirectToBindPhone('/pages/orders/orders');
        return;
      }
      this.setData({ message: error.message || '加载失败，请稍后重试' });
    });
  },

  openOrder(event) {
    wx.navigateTo({ url: `/pages/order-detail/order-detail?id=${encodeURIComponent(event.currentTarget.dataset.id)}` });
  }
});
