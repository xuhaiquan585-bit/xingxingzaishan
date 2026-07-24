const { login, bindPhone } = require('../../utils/auth');

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
    title: SOURCE_COPY.generic.title,
    subtitle: SOURCE_COPY.generic.subtitle,
    message: '',
    binding: false
  },

  onLoad(options) {
    const copy = SOURCE_COPY[options.source] || SOURCE_COPY.generic;
    this.setData({
      redirect: decodeURIComponent(options.redirect || '/pages/home/home'),
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
      this.setData({ message: '需要授权手机号后继续。' });
      return;
    }
    this.setData({
      binding: true,
      message: '正在登录...'
    });
    bindPhone(code).then(() => {
      goAfterBind(this.data.redirect);
    }).catch((error) => {
      this.setData({
        binding: false,
        message: error.message || '手机号绑定失败，请稍后重试'
      });
    });
  }
});
