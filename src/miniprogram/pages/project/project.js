const { request } = require('../../utils/request');

Page({
  data: {
    content: {
      project_title: '星星在闪',
      project_body: '把值得记住的时刻，留在一件看得见的物品上。',
      brand_story_title: '关于记在星上',
      brand_story_body: '我们希望每一件被认真送出的物品，都能留下属于它和收礼人的一段记忆。',
      share_title: '记在星上，闪到永远',
      share_description: '一张照片，一句话，留住一个值得记住的时刻。'
    },
    message: '加载中...'
  },

  onLoad() {
    this.loadContent();
  },

  onShareAppMessage() {
    return {
      title: this.data.content.share_title,
      path: '/pages/project/project'
    };
  },

  loadContent() {
    request({
      url: '/api/miniapp/content',
      auth: false
    }).then((data) => {
      this.setData({ content: data, message: '' });
    }).catch((error) => {
      this.setData({ message: error.message || '加载失败，请稍后重试' });
    });
  },

  goHelp() {
    wx.navigateTo({ url: '/pages/help/help' });
  },

  openPrivacy() {
    if (!wx.openPrivacyContract) {
      wx.showToast({ title: '请在微信中查看隐私保护指引', icon: 'none' });
      return;
    }
    wx.openPrivacyContract({
      fail: () => wx.showToast({ title: '暂时无法打开，请稍后重试', icon: 'none' })
    });
  }
});
