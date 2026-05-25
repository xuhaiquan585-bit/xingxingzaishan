/**
 * api.js — 统一网络请求封装，含友好错误提示
 */

/* 错误码 → 中文提示映射（后端未返回友好 message 时使用） */
const ERROR_MESSAGES = {
  NETWORK_ERROR: '网络连接失败，请检查网络后重试',
  REQUEST_TIMEOUT: '请求超时，请检查网络后重试',
  SERVER_ERROR: '服务器暂时繁忙，请稍后再试',
  UPLOAD_FAILED: '上传失败，请换张图片试试',
  OSS_UPLOAD_FAILED: '云存储暂时不可用，请稍后重试',
  OSS_CONFIG_ERROR: '上传服务暂时不可用，请联系客服',
  OSS_DEP_MISSING: '上传服务暂时不可用，请联系客服',
  QR_NOT_FOUND: '未找到这颗星，请确认二维码是否正确',
  QR_HIDDEN: '这颗星暂不可见',
  QR_ALREADY_ACTIVATED: '该星已被点亮，无法重复绑定',
  INVALID_PHONE: '手机号格式不正确，请检查后重试',
  INVALID_VERIFY_CODE: '验证码错误或已过期，请重新获取',
  SMS_SEND_TOO_FREQUENT: '发送过于频繁，请稍后再试',
  SMS_SERVICE_UNAVAILABLE: '短信服务暂时不可用，请稍后再试',
  LEGACY_LOGIN_DISABLED: '当前登录方式已下线，请使用短信验证码登录',
  VALIDATION_ERROR: '请先上传一张照片再点亮',
  UPLOAD_SIZE_EXCEEDED: '图片过大，请选择 5MB 以内的图片'
};

const DEFAULT_REQUEST_TIMEOUT_MS = 15000;
const UPLOAD_REQUEST_TIMEOUT_MS = 60000;

function getRequestTimeout(url, options) {
  if (Number.isFinite(options.timeoutMs)) {
    return options.timeoutMs;
  }
  const method = (options.method || 'GET').toUpperCase();
  if (url === '/api/upload' || method !== 'GET') {
    return UPLOAD_REQUEST_TIMEOUT_MS;
  }
  return DEFAULT_REQUEST_TIMEOUT_MS;
}

async function apiRequest(url, options = {}) {
  const timeoutMs = getRequestTimeout(url, options);
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);
  const { timeoutMs: _timeoutMs, signal: externalSignal, ...fetchOptions } = options;

  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort();
    } else {
      externalSignal.addEventListener('abort', () => controller.abort(), { once: true });
    }
  }

  const requestOptions = {
    credentials: 'include',
    ...fetchOptions,
    signal: controller.signal
  };

  let response;
  try {
    response = await fetch(url, requestOptions);
  } catch (_networkError) {
    // fetch 本身抛异常：网络断开、DNS 失败、超时等
    const isTimeout = controller.signal.aborted && !(externalSignal && externalSignal.aborted);
    const error = new Error(isTimeout ? ERROR_MESSAGES.REQUEST_TIMEOUT : ERROR_MESSAGES.NETWORK_ERROR);
    error.code = isTimeout ? 'REQUEST_TIMEOUT' : 'NETWORK_ERROR';
    throw error;
  } finally {
    window.clearTimeout(timeoutId);
  }

  let json;
  try {
    json = await response.json();
  } catch (_parseError) {
    // 响应不是 JSON（如 Nginx 502 HTML 页面）
    const error = new Error(ERROR_MESSAGES.SERVER_ERROR);
    error.code = 'SERVER_ERROR';
    throw error;
  }

  if (!response.ok || json.status !== 'success') {
    // 优先用映射表，其次用后端 message，最后兜底
    const code = json.code || '';
    const message = ERROR_MESSAGES[code] || json.message || '请求失败，请稍后重试';
    const error = new Error(message);
    error.code = code;
    throw error;
  }

  return json;
}
