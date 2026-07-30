const { login, redirectToBindPhone, isPhoneBound } = require('../../utils/auth');
const { request, resolveAssetUrl, getToken } = require('../../utils/request');

const PHONE_REPLACE_UNAVAILABLE_MESSAGE = '更换手机号功能暂未开放';

function maskPhone(phone) {
  const value = String(phone || '').trim();
  if (!/^1\d{10}$/.test(value)) return value;
  return `${value.slice(0, 3)}****${value.slice(7)}`;
}

function getPhoneFromToken() {
  const token = getToken();
  const payload = token && token.split('.')[1];
  if (!payload || !wx.base64ToArrayBuffer) return '';
  try {
    let base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    while (base64.length % 4) base64 += '=';
    const bytes = new Uint8Array(wx.base64ToArrayBuffer(base64));
    let json = '';
    for (let index = 0; index < bytes.length; index += 1) {
      json += String.fromCharCode(bytes[index]);
    }
    const data = JSON.parse(json);
    return maskPhone(data && data.phone);
  } catch (error) {
    return '';
  }
}

function formatRecordDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${year}年${month}月${day}日`;
}

Page({
  data: {
    records: [],
    visibleRecords: [],
    activeFilter: 'all',
    recordCounts: {
      all: 0,
      saved: 0,
      coCreating: 0
    },
    currentPhoneText: '',
    loading: true,
    message: '加载中...'
  },

  onLoad() {
    login().then((data) => {
      this.setData({ currentPhoneText: maskPhone(data.phone) || getPhoneFromToken() });
      return this.loadRecords();
    }).catch((error) => {
      this.setData({ loading: false, message: error.message || '登录失败，请稍后重试' });
    });
  },

  loadRecords() {
    request({
      url: '/api/miniapp/user/records'
    }).then((data) => {
      const records = (data.records || []).map((item) => ({
        ...item,
        image_url: resolveAssetUrl(item.image_url),
        display_content: item.content || '（未填写留言）',
        display_date: formatRecordDate(item.display_at || item.activated_at),
        display_qr_id: item.id,
        status_label: item.activation_status === 'co_creating' ? '共创中' : '已保存',
        action_text: item.activation_status === 'co_creating' ? '继续共创' : '查看详情'
      }));
      this.setData({
        records,
        recordCounts: {
          all: records.length,
          saved: records.filter((item) => item.activation_status !== 'co_creating').length,
          coCreating: records.filter((item) => item.activation_status === 'co_creating').length
        },
        loading: false,
        message: ''
      }, () => this.applyRecordFilter());
    }).catch((error) => {
      if (error.code === 'PHONE_NOT_BOUND') {
        redirectToBindPhone('/pages/me/me');
        return;
      }
      this.setData({ loading: false, message: error.message || '加载失败，请稍后重试' });
    });
  },

  applyRecordFilter() {
    const { activeFilter, records } = this.data;
    const visibleRecords = activeFilter === 'all'
      ? records
      : records.filter((item) => (
        activeFilter === 'co_creating'
          ? item.activation_status === 'co_creating'
          : item.activation_status !== 'co_creating'
      ));
    this.setData({ visibleRecords });
  },

  changeRecordFilter(event) {
    const filter = event.currentTarget.dataset.filter || 'all';
    if (!['all', 'saved', 'co_creating'].includes(filter)) return;
    this.setData({ activeFilter: filter }, () => this.applyRecordFilter());
  },

  openRecord(event) {
    const item = this.data.records.find((record) => record.id === event.currentTarget.dataset.id);
    if (item && item.activation_status === 'co_creating') {
      wx.navigateTo({ url: `/pages/co-create/co-create?key=${encodeURIComponent(item.id)}` });
      return;
    }
    wx.navigateTo({ url: `/pages/record-detail/record-detail?id=${encodeURIComponent(event.currentTarget.dataset.id)}` });
  },

  changePhone() {
    if (this.data.currentPhoneText || isPhoneBound()) {
      wx.showToast({ title: PHONE_REPLACE_UNAVAILABLE_MESSAGE, icon: 'none' });
      return;
    }
    redirectToBindPhone('/pages/me/me');
  },

  goOrders() {
    wx.navigateTo({ url: '/pages/orders/orders' });
  },

  goHome() {
    wx.switchTab({ url: '/pages/home/home' });
  }
});
