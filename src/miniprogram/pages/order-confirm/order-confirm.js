const { login, redirectToBindPhone } = require('../../utils/auth');
const { request, resolveAssetUrl } = require('../../utils/request');
const { payMiniappOrder, isPaymentCancelled } = require('../../utils/payment');
const { resolveQuantityLimit, normalizeQuantity, calculateTotalText } = require('../../utils/orderQuantity');

Page({
  data: {
    productId: '',
    product: null,
    quantity: 1,
    quantityInput: '1',
    quantityLimit: 99,
    receiverName: '',
    receiverPhone: '',
    region: '',
    address: '',
    remark: '',
    totalText: '¥0.00',
    message: '加载中...',
    submitting: false,
    coverFailed: false
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
      const quantityLimit = resolveQuantityLimit(product);
      const initialQuantity = quantityLimit > 0 ? 1 : 0;
      this.setData({
        product,
        quantity: initialQuantity,
        quantityInput: String(initialQuantity),
        quantityLimit,
        message: quantityLimit > 0 ? '' : '该商品已售罄。',
        coverFailed: false
      }, () => this.updateTotal());
    }).catch((error) => {
      this.setData({ message: error.message || '加载失败，请稍后重试' });
    });
  },

  updateTotal() {
    const priceCents = Number((this.data.product && this.data.product.price_cents) || 0);
    this.setData({ totalText: calculateTotalText(priceCents, this.data.quantity) });
  },

  changeQuantity(event) {
    const delta = Number(event.currentTarget.dataset.delta || 0);
    const quantity = normalizeQuantity(Number(this.data.quantity || 1) + delta, this.data.quantityLimit);
    this.setData({ quantity, quantityInput: String(quantity) }, () => this.updateTotal());
  },

  onQuantityFocus() {
    this.setData({ quantityInput: '' });
  },

  onQuantityInput(event) {
    const rawValue = String(event.detail.value || '').trim();
    if (!rawValue) {
      this.setData({ quantityInput: '' });
      return;
    }
    const quantity = normalizeQuantity(rawValue, this.data.quantityLimit);
    this.setData({ quantity, quantityInput: String(quantity) }, () => this.updateTotal());
  },

  onQuantityBlur() {
    const quantity = normalizeQuantity(this.data.quantityInput || this.data.quantity, this.data.quantityLimit);
    this.setData({ quantity, quantityInput: String(quantity) }, () => this.updateTotal());
  },

  onRegionChange(event) {
    this.setData({ region: (event.detail.value || []).join(' ') });
  },

  onInput(event) {
    this.setData({ [event.currentTarget.dataset.field]: event.detail.value });
  },

  onCoverError() {
    this.setData({ coverFailed: true });
  },

  openOrder(orderId) {
    setTimeout(() => {
      wx.redirectTo({ url: `/pages/order-detail/order-detail?id=${encodeURIComponent(orderId)}` });
    }, 500);
  },

  submitOrder() {
    if (!this.data.product || this.data.submitting) return;
    if (this.data.quantityLimit <= 0 || Number(this.data.product.inventory_count || 0) <= 0) {
      this.setData({ message: '该商品已售罄，暂时无法购买。' });
      return;
    }
    const quantity = normalizeQuantity(this.data.quantityInput || this.data.quantity, this.data.quantityLimit);
    if (quantity !== this.data.quantity || String(quantity) !== this.data.quantityInput) {
      this.setData({ quantity, quantityInput: String(quantity) }, () => this.updateTotal());
    }
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

    this.setData({ message: '', submitting: true });
    let createdOrder = null;
    request({
      url: '/api/miniapp/orders',
      method: 'POST',
      data: {
        product_id: this.data.product.id,
        quantity,
        receiver_name: this.data.receiverName,
        receiver_phone: this.data.receiverPhone,
        region: this.data.region,
        address: this.data.address,
        remark: this.data.remark
      }
    }).then((order) => {
      createdOrder = order;
      return payMiniappOrder(order.id);
    }).then((result) => {
      const order = result.order || createdOrder;
      wx.showToast({ title: '支付已完成', icon: 'success' });
      this.openOrder(order.id);
    }).catch((error) => {
      if (error.code === 'PHONE_NOT_BOUND') {
        this.setData({ submitting: false });
        redirectToBindPhone(`/pages/order-confirm/order-confirm?product_id=${encodeURIComponent(this.data.productId)}`);
        return;
      }
      if (isPaymentCancelled(error)) {
        wx.showToast({ title: '已取消支付', icon: 'none' });
        if (createdOrder) {
          this.openOrder(createdOrder.id);
          return;
        }
        this.setData({ submitting: false });
        return;
      }
      if (createdOrder) {
        this.setData({ message: '订单已创建，支付未完成，可在订单详情继续支付。' });
        this.openOrder(createdOrder.id);
        return;
      }
      this.setData({ submitting: false, message: error.message || '下单失败，请稍后重试' });
    });
  }
});
