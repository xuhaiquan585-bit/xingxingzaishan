const { login, bindPhone, normalizeBindPhoneSource } = require('../../utils/auth');

const SOURCE_COPY = {
  upload: {
    title: '验证手机号，继续添加照片',
    subtitle: '刚才填写的文字和选项已为你保留。\n验证后，这条记录会与你的手机号关联，方便以后查看和管理。\n验证完成后，请继续选择照片。'
  },
  'replace-photo': {
    title: '验证手机号，继续添加照片',
    subtitle: '刚才填写的文字和选项已为你保留。\n验证后，这条记录会与你的手机号关联，方便以后查看和管理。\n验证完成后，请继续选择照片。'
  },
  submit: {
    title: '验证手机号，继续保存记录',
    subtitle: '刚才填写的内容已为你保留。\n验证后，这条记录会与你的手机号关联，方便以后查看和管理。\n验证完成后，会回到记录页继续确认。'
  },
  generic: {
    title: '验证手机号，继续完成这条记录',
    subtitle: '验证后，这条记录会与你的手机号关联，方便以后查看和管理。'
  }
};

const TAB_PAGES = new Set([
  '/pages/home/home',
  '/pages/products/products',
  '/pages/me/me',
  '/pages/project/project'
]);

const BIND_PHONE_ERROR_MESSAGES = {
  PHONE_ALREADY_BOUND_TO_OTHER_WECHAT: '这个手机号已关联其他微信账号，暂时无法绑定。',
  MINIAPP_PHONE_REPLACE_REQUIRED: '当前微信账号已绑定手机号，更换手机号功能暂未开放。',
  MINIAPP_ACCOUNT_CONFLICT: '账号状态异常，暂时无法绑定手机号，请联系客服处理。',
  PHONE_BIND_FAILED: '暂时无法获取微信手机号，请稍后重试。',
  WECHAT_CONFIG_ERROR: '暂时无法获取微信手机号，请稍后重试。'
};

function goAfterBind(redirect) {
  const path = String(redirect || '/pages/home/home').split('?')[0];
  if (TAB_PAGES.has(path)) {
    wx.switchTab({ url: path });
    return;
  }
  wx.redirectTo({ url: redirect || '/pages/home/home' });
}

Page({
  data: {
    redirect: '/pages/home/home',
    source: '',
    title: SOURCE_COPY.generic.title,
    subtitle: SOURCE_COPY.generic.subtitle,
    message: '',
    binding: false
  },

  onLoad(options) {
    const source = normalizeBindPhoneSource(options.source);
    const copy = SOURCE_COPY[source] || SOURCE_COPY.generic;
    this.setData({
      redirect: decodeURIComponent(options.redirect || '/pages/home/home'),
      source,
      title: copy.title,
      subtitle: copy.subtitle
    });
    login().catch((error) => {
      this.setData({ message: error.message || '登录失败，请稍后重试' });
    });
  },

  onGetPhoneNumber(event) {
    const code = event.detail && event.detail.code;
    if (!code) {
      this.setData({ message: '未获取到微信手机号，请再次尝试。' });
      return;
    }
    this.setData({
      binding: true,
      message: '正在验证手机号...'
    });
    bindPhone(code).then(() => {
      goAfterBind(this.data.redirect);
    }).catch((error) => {
      this.setData({
        binding: false,
        message: BIND_PHONE_ERROR_MESSAGES[error.code] || error.message || '暂时无法获取微信手机号，请稍后重试。'
      });
    });
  },

  onUseOtherPhone() {
    if (this.data.binding) return;
    const query = [`redirect=${encodeURIComponent(this.data.redirect || '/pages/home/home')}`];
    if (this.data.source) {
      query.push(`source=${encodeURIComponent(this.data.source)}`);
    }
    wx.navigateTo({
      url: `/pages/bind-phone-sms/bind-phone-sms?${query.join('&')}`
    });
  }
});
