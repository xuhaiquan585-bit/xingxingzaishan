(function () {
  const shopLinks = Array.from(document.querySelectorAll('[data-wechat-shop]'));
  const shopStatus = document.getElementById('shopStatus');

  function isSafeHttpUrl(value) {
    try {
      const url = new URL(String(value || '').trim());
      return url.protocol === 'https:' || url.protocol === 'http:';
    } catch (_error) {
      return false;
    }
  }

  function setShopUrl(url) {
    shopLinks.forEach((link) => {
      link.href = url;
      link.removeAttribute('aria-disabled');
      link.removeAttribute('tabindex');
      link.rel = 'noopener noreferrer';
    });
    if (shopStatus) {
      shopStatus.textContent = '点击下方按钮，前往微信店铺查看和购买星贴。';
    }
  }

  function setShopUnavailable() {
    shopLinks.forEach((link) => {
      link.removeAttribute('href');
      link.setAttribute('aria-disabled', 'true');
      link.setAttribute('tabindex', '-1');
      link.removeAttribute('rel');
    });
    if (shopStatus) {
      shopStatus.textContent = '微信店铺入口暂未开放，请稍后再来。';
    }
  }

  async function loadShopUrl() {
    try {
      const response = await fetch('/api/miniapp/content', {
        headers: { Accept: 'application/json' }
      });
      if (!response.ok) throw new Error('content request failed');
      const payload = await response.json();
      const shopUrl = payload && payload.data ? payload.data.wechat_shop_url : '';
      if (!isSafeHttpUrl(shopUrl)) {
        setShopUnavailable();
        return;
      }
      setShopUrl(shopUrl);
    } catch (_error) {
      setShopUnavailable();
    }
  }

  loadShopUrl();
})();
