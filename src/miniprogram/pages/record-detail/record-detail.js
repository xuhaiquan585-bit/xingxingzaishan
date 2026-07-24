const { login, redirectToBindPhone } = require('../../utils/auth');
const { request, resolveAssetUrl, getToken } = require('../../utils/request');

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
  const hour = `${date.getHours()}`.padStart(2, '0');
  const minute = `${date.getMinutes()}`.padStart(2, '0');
  return `${year}年${month}月${day}日 ${hour}:${minute}`;
}

function truncateHash(value) {
  const hash = String(value || '');
  if (hash.length <= 22) return hash;
  return `${hash.slice(0, 12)}…${hash.slice(-6)}`;
}

function isHttpUrl(value) {
  return /^https?:\/\//.test(String(value || ''));
}

Page({
  data: {
    id: '',
    record: null,
    currentPhoneText: '',
    hashExpanded: false,
    hashButtonText: '查看完整哈希',
    message: '加载中...'
  },

  onLoad(options) {
    this.setData({ id: options.id || '' });
    login().then((data) => {
      this.setData({ currentPhoneText: maskPhone(data.phone) || getPhoneFromToken() });
      return this.loadDetail();
    }).catch((error) => {
      this.setData({ message: error.message || '登录失败，请稍后重试' });
    });
  },

  loadDetail() {
    request({
      url: `/api/miniapp/user/records/${encodeURIComponent(this.data.id)}`
    }).then((data) => {
      const brandDisclosureText = String(data.brand_disclosure_text_snapshot || '').trim();
      const brandName = String(data.brand_name || '').trim();
      const brandDisclosureDisplay = [brandName, brandDisclosureText].filter(Boolean).join(' · ');
      const fullHash = data.manifest_hash || data.blockchain_hash || '';
      this.setData({
        hashExpanded: false,
        hashButtonText: '查看完整哈希',
        record: {
          ...data,
          image_url: resolveAssetUrl(data.image_url),
          display_content: data.content || '（未填写留言）',
          display_date: formatRecordDate(data.activated_at || data.display_at),
          display_qr_id: data.id,
          full_hash: fullHash,
          hash_display: truncateHash(fullHash),
          has_hash: !!fullHash,
          has_certificate_url: isHttpUrl(data.chain_certificate_url),
          has_brand_disclosure: data.show_brand_disclosure === true && !!brandDisclosureText,
          brand_disclosure_display: brandDisclosureDisplay,
          has_comments: Array.isArray(data.co_creation_comments) && data.co_creation_comments.length > 0
        },
        message: ''
      });
    }).catch((error) => {
      if (error.code === 'PHONE_NOT_BOUND') {
        redirectToBindPhone(`/pages/record-detail/record-detail?id=${encodeURIComponent(this.data.id)}`);
        return;
      }
      this.setData({ message: error.message || '加载失败，请稍后重试' });
    });
  },

  toggleHash() {
    if (!this.data.record || !this.data.record.has_hash) return;
    const hashExpanded = !this.data.hashExpanded;
    this.setData({
      hashExpanded,
      hashButtonText: hashExpanded ? '收起完整哈希' : '查看完整哈希',
      record: {
        ...this.data.record,
        hash_display: hashExpanded ? this.data.record.full_hash : truncateHash(this.data.record.full_hash)
      }
    });
  },

  copyHash() {
    const hash = this.data.record && this.data.record.full_hash;
    if (!hash) return;
    wx.setClipboardData({
      data: hash,
      success: () => wx.showToast({ title: '已复制存证哈希', icon: 'none' }),
      fail: () => wx.showToast({ title: '复制失败，请长按选择复制', icon: 'none' })
    });
  },

  openCertificate() {
    const url = this.data.record && this.data.record.chain_certificate_url;
    if (!isHttpUrl(url)) return;
    wx.setClipboardData({
      data: url,
      success: () => wx.showToast({ title: '存证信息链接已复制', icon: 'none' }),
      fail: () => wx.showToast({ title: '复制失败，请稍后重试', icon: 'none' })
    });
  },

  changePhone() {
    redirectToBindPhone(`/pages/record-detail/record-detail?id=${encodeURIComponent(this.data.id)}`);
  },

  goMe() {
    wx.switchTab({ url: '/pages/me/me' });
  }
});
