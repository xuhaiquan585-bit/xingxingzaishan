const { login, redirectToBindPhone } = require('../../utils/auth');
const { request, resolveAssetUrl } = require('../../utils/request');

const FILTERS = [
  { value: 'all', label: '全部' },
  { value: 'pending_payment', label: '待支付' },
  { value: 'paid', label: '待发货' },
  { value: 'shipped', label: '已发货' },
  { value: 'completed', label: '已完成' }
];

function formatOrderTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (part) => String(part).padStart(2, '0');
  return `${date.getFullYear()}.${pad(date.getMonth() + 1)}.${pad(date.getDate())}`;
}

Page({
  data: {
    orders: [],
    visibleOrders: [],
    filters: FILTERS,
    activeFilter: 'all',
    message: '加载中...',
    loading: true
  },

  onLoad() {
    login().then(() => this.loadOrders()).catch((error) => {
      this.setData({ message: error.message || '登录失败，请稍后重试', loading: false });
    });
  },

  onShow() {
    if (this.data.orders.length) this.loadOrders();
  },

  loadOrders() {
    this.setData({ loading: true });
    request({ url: '/api/miniapp/orders' }).then((data) => {
      const orders = (data.orders || []).map((item) => ({
        ...item,
        cover_image: resolveAssetUrl((item.product_snapshot || {}).cover_image),
        created_text: formatOrderTime(item.created_at),
        image_failed: false
      }));
      this.setData({ orders, loading: false, message: '' }, () => this.applyOrderFilter());
    }).catch((error) => {
      if (error.code === 'PHONE_NOT_BOUND') {
        redirectToBindPhone('/pages/orders/orders');
        return;
      }
      this.setData({ message: error.message || '加载失败，请稍后重试', loading: false });
    });
  },

  applyOrderFilter() {
    const active = this.data.activeFilter;
    const visibleOrders = active === 'all'
      ? this.data.orders
      : this.data.orders.filter((item) => item.status === active);
    this.setData({ visibleOrders });
  },

  changeOrderFilter(event) {
    this.setData({ activeFilter: event.currentTarget.dataset.value }, () => this.applyOrderFilter());
  },

  onOrderImageError(event) {
    const id = event.currentTarget.dataset.id;
    const orders = this.data.orders.map((item) => item.id === id ? { ...item, image_failed: true } : item);
    this.setData({ orders }, () => this.applyOrderFilter());
  },

  openOrder(event) {
    wx.navigateTo({ url: `/pages/order-detail/order-detail?id=${encodeURIComponent(event.currentTarget.dataset.id)}` });
  },

  goProducts() {
    wx.switchTab({ url: '/pages/products/products' });
  }
});
