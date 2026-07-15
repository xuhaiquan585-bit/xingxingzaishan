const { login, redirectToBindPhone } = require('../../utils/auth');
const { request, resolveAssetUrl } = require('../../utils/request');

Page({
  data: {
    productId: '',
    product: null,
    quantity: 1,
    receiverName: '',
    receiverPhone: '',
    region: '',
    address: '',
    remark: '',
    totalText: '¥0.00',
    message: '加载中...'
  },

  onLoad(options) {
    this.setData({ productId: options.product_id || '' });
    login().then(() => this.loadProduct()).catch((error) => {
      this.setData({ message: error.message || '登录失败，请稍后重试' });
    });
  },

  loadProduct() {
    if (!this.data.productId) {
      this.setData({ message: '缺少商品编号' });
      return;
    }
    request({
      url: `/api/miniapp/products/${encodeURIComponent(this.data.productId)}`,
      auth: false
    }).then((data) => {
      const product = {
        ...data,
        cover_image: resolveAssetUrl(data.cover_image),
        images: (data.images || []).map(resolveAssetUrl)
      };
      this.setData({ product, message: '' }, () => this.updateTotal());
    }).catch((error) => {
      this.setData({ message: error.message || '加载失败，请稍后重试' });
    });
  },

  updateTotal() {
    const cents = Number((this.data.product && this.data.product.price_cents) || 0) * Number(this.data.quantity || 1);
    this.setData({ totalText: `¥${(cents / 100).toFixed(2)}` });
  },

  onQuantityInput(event) {
    const value = Math.max(1, Math.min(99, Number(event.detail.value || 1)));
    this.setData({ quantity: value }, () => this.updateTotal());
  },

  onRegionChange(event) {
    this.setData({ region: (event.detail.value || []).join(' ') });
  },

  onInput(event) {
    this.setData({ [event.currentTarget.dataset.field]: event.detail.value });
  },

  submitOrder() {
    if (!this.data.product) return;
    this.setData({ message: '' });
    request({
      url: '/api/miniapp/orders',
      method: 'POST',
      data: {
        product_id: this.data.product.id,
        quantity: this.data.quantity,
        receiver_name: this.data.receiverName,
        receiver_phone: this.data.receiverPhone,
        region: this.data.region,
        address: this.data.address,
        remark: this.data.remark
      }
    }).then((order) => request({
      url: `/api/miniapp/orders/${encodeURIComponent(order.id)}/pay`,
      method: 'POST'
    })).then((payResult) => {
      const order = payResult.order || {};
      wx.showToast({ title: '下单成功', icon: 'success' });
      wx.redirectTo({ url: `/pages/order-detail/order-detail?id=${encodeURIComponent(order.id)}` });
    }).catch((error) => {
      if (error.code === 'PHONE_NOT_BOUND') {
        redirectToBindPhone(`/pages/order-confirm/order-confirm?product_id=${encodeURIComponent(this.data.productId)}`);
        return;
      }
      this.setData({ message: error.message || '下单失败，请稍后重试' });
    });
  }
});
