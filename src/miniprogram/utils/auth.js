const { request, getToken, setToken, setPhoneBound, isPhoneBound } = require('./request');

const BIND_PHONE_SOURCES = new Set(['upload', 'replace-photo', 'submit']);

function login() {
  const existed = getToken();
  if (existed) {
    return Promise.resolve({
      token: existed,
      phone_bound: isPhoneBound()
    });
  }

  return new Promise((resolve, reject) => {
    wx.login({
      success(res) {
        if (!res.code) {
          reject(new Error('微信登录失败，请稍后重试'));
          return;
        }
        request({
          url: '/api/miniapp/auth/login',
          method: 'POST',
          auth: false,
          data: { code: res.code }
        }).then((data) => {
          setToken(data.token);
          setPhoneBound(data.phone_bound === true);
          resolve(data);
        }).catch(reject);
      },
      fail() {
        reject(new Error('微信登录失败，请稍后重试'));
      }
    });
  });
}

function bindPhone(code) {
  return request({
    url: '/api/miniapp/auth/bind-phone',
    method: 'POST',
    data: { code }
  }).then((data) => {
    setToken(data.token);
    setPhoneBound(true);
    return data;
  });
}

function redirectToBindPhone(redirect, source = '') {
  const safeSource = BIND_PHONE_SOURCES.has(source) ? source : '';
  const query = [`redirect=${encodeURIComponent(redirect || '/pages/home/home')}`];
  if (safeSource) query.push(`source=${encodeURIComponent(safeSource)}`);
  wx.navigateTo({
    url: `/pages/bind-phone/bind-phone?${query.join('&')}`
  });
}

module.exports = {
  login,
  bindPhone,
  redirectToBindPhone,
  isPhoneBound
};
