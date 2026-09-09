'use strict';

const TEMPLATE_VALIDATION_MESSAGES = Object.freeze({
  NUMBER_OUT_OF_RANGE: '数值超出允许范围，请检查对应字段。',
  COLOR_INVALID: '颜色格式无效，请使用 #RRGGBB 格式。',
  TEXT_INVALID: '文字不能为空，或文字长度超过了允许上限。',
  ELEMENT_OUT_OF_BOUNDS: '元素超出标签画布，请调整它的位置或宽高。',
  FONT_FAMILY_INVALID: '字体不受支持，请使用编辑器提供的内置字体。',
  TEXT_ALIGN_INVALID: '文字对齐方式无效，请重新选择对齐方式。',
  ELEMENT_INVALID: '元素数据不完整，请删除后重新添加该元素。',
  ELEMENT_TYPE_INVALID: '元素类型不受支持，请删除后重新添加该元素。',
  ELEMENT_ID_INVALID: '元素标识无效，请删除后重新添加该元素。',
  ELEMENT_ID_DUPLICATE: '模板中存在重复元素，请删除重复项。',
  ELEMENT_COUNT_INVALID: '模板元素数量必须在 1 到 64 个之间。',
  QR_GEOMETRY_INVALID: '二维码必须为正方形，且边长不能小于 10 mm。',
  QR_ELEMENT_REQUIRED: '模板必须且只能包含一个二维码。',
  ID_ELEMENT_REQUIRED: '模板必须且只能包含一个二维码 ID。',
  QR_ID_COMPONENT_REVISION_INVALID: '二维码 ID 组件版本无效，请执行组件升级。',
  QR_ID_COMPONENT_GEOMETRY_INVALID: '二维码 ID 已偏离二维码，请重新同步二维码 ID 组件。',
  QR_ID_COMPONENT_ALIGNMENT_INVALID: '二维码 ID 必须在二维码下方水平居中。',
  QR_ID_COMPONENT_FONT_INVALID: '二维码 ID 字体不符合生产版本，请重新同步二维码 ID 组件。',
  QR_ID_COMPONENT_COLOR_INVALID: '二维码 ID 颜色不符合生产版本，请重新同步二维码 ID 组件。',
  QR_ID_COMPONENT_OVERLAP: '有元素遮挡二维码 ID，请将该元素移出编号区域。',
  QR_OVERLAP_FORBIDDEN: '有元素遮挡二维码，请将该元素移出二维码区域。',
  IMAGE_FIT_INVALID: '图片填充方式无效，请选择完整显示或裁切填充。',
  IMAGE_ASSET_MISSING: '模板引用的图片不存在，请重新上传并选择图片。',
  IMAGE_RESOLUTION_TOO_LOW: '图片分辨率不足以按 600 DPI 输出，请缩小图片区域或上传更清晰的图片。'
});

const BAD_REQUEST_MESSAGES = Object.freeze({
  TEMPLATE_NAME_INVALID: '模板名称不能为空，且不能超过 160 个字符。',
  TEMPLATE_ASSET_TYPE_INVALID: '模板图片用途无效，请选择标志或背景。',
  QR_ID_INVALID: '预览二维码 ID 格式无效，请输入有效的二维码编号。',
  TEXT_OVERFLOW: '文字内容超出文本框，无法完整生成。请增大文本框、减小字号或缩短文字。',
  QR_PHYSICAL_SIZE_TOO_SMALL: '二维码尺寸过小，无法满足印刷清晰度要求。请增大二维码并保持正方形。',
  FONT_NOT_BUNDLED: '模板使用了服务器未提供的字体，请改用编辑器中的内置字体。',
  QR_PAYLOAD_REQUIRED: '二维码预览内容为空，请刷新页面后重试。',
  PRINT_QR_IDS_INVALID: '二维码 ID 列表不能为空、格式错误或超过 500 个。',
  IDEMPOTENCY_KEY_INVALID: '本次操作标识无效，请刷新页面后重试。',
  PRINT_TEMPLATE_VERSION_INVALID: '请选择一个有效的已发布模板版本。',
  PRINT_BATCH_NAME_INVALID: '印刷任务名称不能为空，且不能超过 160 个字符。',
  PRINT_VENDOR_NAME_INVALID: '印刷厂家名称不能超过 160 个字符。',
  PRINT_BATCH_NOTE_INVALID: '印刷任务备注不能超过 500 个字符。',
  PRINT_VOID_REASON_INVALID: '请填写有效的报废原因，且不能超过 500 个字符。',
  PRINT_HISTORY_FILTER_INVALID: '历史二维码筛选条件无效，请修改后重试。',
  PRINT_HISTORY_TARGET_INVALID: '请选择 1 到 500 个历史二维码。'
});

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function compactData(input) {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function presentValidationIssue(input) {
  const issue = input && typeof input === 'object' ? input : {};
  const code = String(issue.code || 'LABEL_TEMPLATE_INVALID');
  return {
    code,
    path: String(issue.path || ''),
    message: TEMPLATE_VALIDATION_MESSAGES[code]
      || '模板元素不符合生产要求，请检查其位置、尺寸和样式。'
  };
}

function printProductionHttpError(error) {
  const code = String(error && error.code || 'PRINT_PRODUCTION_UNAVAILABLE');
  if (code === 'LABEL_TEMPLATE_INVALID') {
    const issues = Array.isArray(error && error.issues)
      ? error.issues.map(presentValidationIssue) : [];
    return {
      statusCode: 400,
      body: {
        status: 'error',
        code,
        message: issues.length
          ? `模板有 ${issues.length} 处生产校验问题，请按提示调整。`
          : '模板未通过生产校验，请检查元素的位置、尺寸和样式。',
        data: { issues }
      }
    };
  }
  if (Object.prototype.hasOwnProperty.call(BAD_REQUEST_MESSAGES, code)) {
    const data = code === 'TEXT_OVERFLOW' ? compactData({
      element_id: String(error && error.elementId || ''),
      element_type: String(error && error.elementType || ''),
      width_mm: finiteNumber(error && error.widthMm),
      height_mm: finiteNumber(error && error.heightMm),
      font_size_pt: finiteNumber(error && error.fontSizePt)
    }) : undefined;
    return {
      statusCode: 400,
      body: compactData({
        status: 'error', code, message: BAD_REQUEST_MESSAGES[code], data
      })
    };
  }
  if (['TEMPLATE_NOT_FOUND', 'TEMPLATE_VERSION_NOT_FOUND',
    'TEMPLATE_ASSET_NOT_FOUND', 'PRINT_BATCH_NOT_FOUND',
    'PRINT_QR_NOT_FOUND'].includes(code)) {
    return {
      statusCode: 404,
      body: { status: 'error', code, message: '未找到对应的模板、版本、图片或印刷任务。' }
    };
  }
  if (['TEMPLATE_ARCHIVED', 'TEMPLATE_DRAFT_NOT_FOUND',
    'TEMPLATE_DRAFT_ALREADY_EXISTS', 'TEMPLATE_NOT_PUBLISHED',
    'TEMPLATE_ALREADY_ARCHIVED', 'PRINT_TEMPLATE_NOT_AVAILABLE'].includes(code)) {
    return {
      statusCode: 409,
      body: { status: 'error', code, message: '当前模板状态不允许执行该操作。' }
    };
  }
  if (code === 'PRINT_QR_NOT_UNACTIVATED') {
    return {
      statusCode: 409,
      body: {
        status: 'error', code,
        message: '所选二维码中包含已记录或共创中的二维码，不能用于新印刷任务。'
      }
    };
  }
  if (code === 'PRINT_QR_ALREADY_RESERVED') {
    return {
      statusCode: 409,
      body: {
        status: 'error', code,
        message: '所选二维码中包含历史未分类、已预留、已打印或已报废的二维码。'
      }
    };
  }
  if (code === 'PRINT_QR_RESERVATION_CONFLICT') {
    return {
      statusCode: 409,
      body: {
        status: 'error', code,
        message: '二维码印刷状态刚刚发生变化，请刷新后重新选择。'
      }
    };
  }
  if (['IDEMPOTENCY_KEY_CONFLICT',
    'PRINT_BATCH_CANNOT_CANCEL', 'PRINT_ARTIFACT_GENERATION_IN_PROGRESS',
    'PRINT_ARTIFACT_GENERATION_NOT_ALLOWED', 'PRINT_ARTIFACT_NOT_READY',
    'PRINT_BATCH_TRANSITION_INVALID', 'PRINT_VOID_QR_SCOPE_INVALID',
    'PRINT_VOID_QR_CONFLICT', 'PRINT_HISTORY_QR_CONFLICT',
    'PRINT_HISTORY_QR_NOT_AVAILABLE'].includes(code)) {
    return {
      statusCode: 409,
      body: { status: 'error', code, message: '当前印刷任务状态不允许执行该操作。' }
    };
  }
  return {
    statusCode: 503,
    body: {
      status: 'error',
      code: 'PRINT_PRODUCTION_UNAVAILABLE',
      message: '印刷生产服务暂时不可用，请稍后重试。'
    }
  };
}

module.exports = {
  presentValidationIssue,
  printProductionHttpError
};
