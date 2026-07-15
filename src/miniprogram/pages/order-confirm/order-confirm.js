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
    if (!String(this.data.receiverName || '').trim()) {
      wx.showToast({ title: '请填写收货人', icon: 'none' });
      return;
    }
    if (!/^1\d{10}$/.test(String(this.data.receiverPhone || '').trim())) {
      wx.showToast({ title: '请填写正确的手机号', icon: 'none' });
      return;
    }
    if (!this.data.region) {
      wx.showToast({ title: '请选择省市区', icon: 'none' });
      return;
    }
    if (!String(this.data.address || '').trim()) {
      wx.showToast({ title: '请填写详细地址', icon: 'none' });
      return;
    }
    if (!Number(this.data.quantity || 0)) {
      wx.showToast({ title: '请选择购买数量', icon: 'none' });
      return;
    }
    this.setData({ message: '' });
    let createdOrder = null;
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
    }).then((order) => {
      createdOrder = order;
      return request({
        url: `/api/miniapp/orders/${encodeURIComponent(order.id)}/pay`,
        method: 'POST'
      });
    }).then((payResult) => {
      if (payResult.payment) {
        return new Promise((resolve, reject) => {
          wx.requestPayment({
            ...payResult.payment,
            success: () => resolve(payResult.order || createdOrder),
            fail: reject
          });
        });
      }
      if (payResult.payment_mock) {
        return payResult.order || createdOrder;
      }
      return payResult.order || createdOrder;
    }).then((order) => {
      wx.showToast({ title: '支付成功', icon: 'success' });
      setTimeout(() => {
        wx.redirectTo({ url: `/pages/order-detail/order-detail?id=${encodeURIComponent((order || createdOrder).id)}` });
      }, 1200);
    }).catch((error) => {
      if (error.code === 'PHONE_NOT_BOUND') {
        redirectToBindPhone(`/pages/order-confirm/order-confirm?product_id=${encodeURIComponent(this.data.productId)}`);
        return;
      }
      if (error.errMsg && error.errMsg.indexOf('cancel') !== -1) {
        wx.showToast({ title: '已取消支付', icon: 'none' });
        return;
      }
      this.setData({ message: error.message || '下单失败，请稍后重试' });
    });
  }
});
