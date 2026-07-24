const { login } = require('../../utils/auth');
const { request, resolveAssetUrl } = require('../../utils/request');
const { extractQrKey } = require('../../utils/qr');

function formatRecordDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${year}年${month}月${day}日`;
}

function isHttpUrl(value) {
  return /^https?:\/\//.test(String(value || ''));
}

Page({
  data: {
    key: '',
    record: null,
    justSaved: false,
    pageTitle: '',
    pageSubtitle: '',
    hashVisible: false,
    hashButtonText: '查看存证信息',
    message: '加载中...'
  },

  onLoad(options) {
    this.setData({
      key: extractQrKey(options),
      justSaved: options.just_saved === '1'
    });
    login().then(() => this.loadRecord()).catch((error) => {
      this.setData({ message: error.message || '登录失败，请稍后重试' });
    });
  },

  onShareAppMessage() {
    return {
      title: '这瓶酒里的记录',
      path: `/pages/result/result?key=${encodeURIComponent(this.data.key)}`
    };
  },

  onShareTimeline() {
    return {
      title: '这瓶酒里的记录',
      query: `key=${encodeURIComponent(this.data.key)}`
    };
  },

  loadRecord() {
    request({
      url: `/api/miniapp/qr/${encodeURIComponent(this.data.key)}`
    }).then((data) => {
      const brandDisclosureText = String(data.brand_disclosure_text_snapshot || '').trim();
      const brandName = String(data.brand_name || '').trim();
      const brandDisclosureDisplay = [brandName, brandDisclosureText].filter(Boolean).join(' · ');
      const manifestHash = data.manifest_hash || data.blockchain_hash || '';
      const displayDate = formatRecordDate(data.activated_at);
      this.setData({
        pageTitle: this.data.justSaved ? '保存成功' : '这瓶酒里的记录',
        pageSubtitle: this.data.justSaved
          ? '以后再扫码，还能回到这一刻'
          : (displayDate ? `保存于 ${displayDate}` : '以后再扫码，还能回到这一刻'),
        record: {
          ...data,
          image_url: resolveAssetUrl(data.image_url),
          display_content: data.content || '（未填写留言）',
          display_date: displayDate,
          display_qr_id: data.id || this.data.key,
          manifest_hash: manifestHash,
          has_hash: !!manifestHash,
          has_certificate_url: isHttpUrl(data.chain_certificate_url),
          has_brand_disclosure: data.show_brand_disclosure === true && !!brandDisclosureText,
          brand_disclosure_display: brandDisclosureDisplay,
          has_comments: Array.isArray(data.co_creation_comments) && data.co_creation_comments.length > 0
        },
        message: ''
      });
    }).catch((error) => {
      this.setData({ message: error.message || '加载失败，请稍后重试' });
    });
  },

  toggleHash() {
    const hashVisible = !this.data.hashVisible;
    this.setData({
      hashVisible,
      hashButtonText: hashVisible ? '收起存证信息' : '查看存证信息'
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

  goMe() {
    wx.switchTab({ url: '/pages/me/me' });
  }
});
