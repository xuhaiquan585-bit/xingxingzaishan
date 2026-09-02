(function labelTemplateEditorModule() {
  'use strict';

  const state = {
    templates: [],
    detail: null,
    schema: null,
    selectedElementId: '',
    assetUrls: new Map(),
    dirty: false,
    loaded: false
  };
  const SNAP_MM = 0.5;
  const POINT_TO_MM = 25.4 / 72;
  const QR_ID_COMPONENT = Object.freeze({
    referenceQrSizeMm: 17,
    gapMm: 0.6,
    heightMm: 2.8,
    fontSizePt: 6.5,
    minimumFontSizePt: 4
  });
  const TYPE_LABELS = {
    background: '背景图', handwriting: '手写区', image: '图片', divider: '分割线',
    qr: '二维码', id: '二维码 ID', text: '文字'
  };

  function el(id) {
    return document.getElementById(id);
  }

  function message(text, isError = false) {
    const target = el('labelTemplateMsg');
    if (!target) return;
    target.textContent = text || '';
    target.classList.toggle('error', isError);
  }

  async function api(path, options = {}) {
    const response = await fetch(`/api/admin${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${localStorage.getItem('adminToken') || ''}`,
        ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
        ...(options.headers || {})
      }
    });
    const data = await response.json().catch(() => ({
      status: 'error', message: '服务器返回了无法识别的响应。'
    }));
    if (!response.ok || data.status !== 'success') {
      const error = new Error(data.message || '请求失败');
      error.code = data.code || 'REQUEST_FAILED';
      error.issues = data.data && data.data.issues;
      throw error;
    }
    return data.data;
  }

  function activeTemplate() {
    return state.detail && state.detail.template;
  }

  function draftVersion() {
    return state.detail && state.detail.versions.find((version) => version.status === 'draft');
  }

  function activeElement() {
    return state.schema && state.schema.elements.find(
      (element) => element.id === state.selectedElementId
    );
  }

  function editable() {
    return Boolean(activeTemplate() && activeTemplate().status !== 'archived' && draftVersion());
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function snap(value) {
    return Math.round(Number(value) / SNAP_MM) * SNAP_MM;
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function rounded(value) {
    return Number(Number(value).toFixed(4));
  }

  function elementByType(type) {
    return state.schema && state.schema.elements.find((element) => element.type === type);
  }

  function synchronizeQrIdComponent() {
    const qr = elementByType('qr');
    const id = elementByType('id');
    if (!qr || !id || id.linkedToQr !== true) return;
    const scale = Number(qr.widthMm) / QR_ID_COMPONENT.referenceQrSizeMm;
    Object.assign(id, {
      xMm: rounded(qr.xMm),
      yMm: rounded(Number(qr.yMm) + Number(qr.heightMm) + QR_ID_COMPONENT.gapMm * scale),
      widthMm: rounded(qr.widthMm),
      heightMm: rounded(QR_ID_COMPONENT.heightMm * scale),
      fontSizePt: rounded(Math.max(
        QR_ID_COMPONENT.minimumFontSizePt,
        Math.min(48, QR_ID_COMPONENT.fontSizePt * scale)
      )),
      minFontSizePt: QR_ID_COMPONENT.minimumFontSizePt,
      align: 'center',
      letterSpacing: 0,
      locked: true
    });
  }

  function statusText(status) {
    return { draft: '草稿', published: '已发布', archived: '已停用' }[status] || status;
  }

  function clearAssetUrls() {
    for (const url of state.assetUrls.values()) URL.revokeObjectURL(url);
    state.assetUrls.clear();
  }

  async function loadAssetUrls() {
    clearAssetUrls();
    if (!state.detail) return;
    await Promise.all(state.detail.assets.map(async (asset) => {
      const response = await fetch(
        `/api/admin/label-templates/${state.detail.template.id}/assets/${asset.id}/preview`,
        { headers: { Authorization: `Bearer ${localStorage.getItem('adminToken') || ''}` } }
      );
      if (response.ok) state.assetUrls.set(asset.id, URL.createObjectURL(await response.blob()));
    }));
  }

  function renderTemplateList() {
    const query = String(el('labelTemplateSearch').value || '').trim().toLowerCase();
    const currentId = activeTemplate() && activeTemplate().id;
    const list = state.templates.filter((template) => (
      !query || template.name.toLowerCase().includes(query)
    ));
    el('labelTemplateList').innerHTML = list.length ? list.map((template) => `
      <button type="button" data-label-template-id="${template.id}"
        class="${template.id === currentId ? 'active' : ''}">
        <span>${escapeHtml(template.name)}</span>
        <small>${statusText(template.status)} · ${template.current_published_version_number
    ? `已发布 v${template.current_published_version_number}` : '尚未发布'}</small>
      </button>
    `).join('') : '<p class="muted">没有匹配的模板</p>';
  }

  function setEditorAvailability() {
    const hasTemplate = Boolean(state.detail);
    el('labelTemplateEmpty').classList.toggle('hidden', hasTemplate);
    el('labelTemplateEditor').classList.toggle('hidden', !hasTemplate);
    if (!hasTemplate) return;
    const template = activeTemplate();
    const draft = draftVersion();
    el('activeLabelTemplateName').textContent = template.name;
    el('activeLabelTemplateStatus').textContent = statusText(template.status);
    el('activeLabelTemplateVersion').textContent = draft
      ? `正在编辑 v${draft.version_number}`
      : template.current_published_version_number
        ? `已发布 v${template.current_published_version_number}` : '无可编辑版本';
    const canEdit = editable();
    ['saveLabelTemplateBtn', 'publishLabelTemplateBtn'].forEach((id) => {
      el(id).disabled = !canEdit;
    });
    el('newLabelTemplateVersionBtn').disabled = template.status !== 'published' || Boolean(draft);
    el('archiveLabelTemplateBtn').disabled = template.status === 'archived';
    document.querySelectorAll('[data-add-label-element], [data-label-align]').forEach((button) => {
      button.disabled = !canEdit;
    });
    el('uploadLabelAssetBtn').disabled = !canEdit;
  }

  function canvasScale() {
    if (!state.schema) return 1;
    return Math.min(8, 420 / state.schema.canvas.widthMm, 620 / state.schema.canvas.heightMm);
  }

  function canvasFontSize(fontSizePt, scale) {
    return Number(fontSizePt) * POINT_TO_MM * scale;
  }

  function canvasFontFamily(fontFamily) {
    return fontFamily === 'ibm-plex-mono'
      ? '"Label IBM Plex Mono", monospace'
      : '"Label Noto Sans SC", sans-serif';
  }

  function renderCanvas() {
    const canvas = el('labelCanvas');
    if (!state.schema) {
      canvas.innerHTML = '';
      return;
    }
    const scale = canvasScale();
    const spec = state.schema.canvas;
    canvas.style.width = `${spec.widthMm * scale}px`;
    canvas.style.height = `${spec.heightMm * scale}px`;
    canvas.style.backgroundColor = spec.backgroundColor;
    canvas.style.borderRadius = `${spec.cornerRadiiMm.topLeft * scale}px ${spec.cornerRadiiMm.topRight * scale}px ${spec.cornerRadiiMm.bottomRight * scale}px ${spec.cornerRadiiMm.bottomLeft * scale}px`;
    canvas.innerHTML = state.schema.elements
      .slice()
      .sort((left, right) => left.zIndex - right.zIndex)
      .map((element) => canvasElementHtml(element, scale))
      .join('');
  }

  function canvasElementHtml(element, scale) {
    const selected = element.id === state.selectedElementId ? ' selected' : '';
    const locked = element.locked ? ' locked' : '';
    const style = [
      `left:${element.xMm * scale}px`, `top:${element.yMm * scale}px`,
      `width:${element.widthMm * scale}px`, `height:${element.heightMm * scale}px`,
      `z-index:${element.zIndex}`, `opacity:${element.opacity == null ? 1 : element.opacity}`
    ];
    let content = '';
    if (element.type === 'id') {
      const justify = { left: 'flex-start', center: 'center', right: 'flex-end' }[element.align]
        || 'flex-start';
      style.push(`color:${element.color}`,
        `font-size:${canvasFontSize(element.fontSizePt, scale)}px`,
        `font-family:${canvasFontFamily(element.fontFamily)}`,
        'font-weight:500', 'display:flex', 'align-items:center', `justify-content:${justify}`,
        `text-align:${element.align}`);
      content = 'SSS00016';
    } else if (element.type === 'text') {
      style.push(`color:${element.color}`,
        `font-size:${canvasFontSize(element.fontSizePt, scale)}px`,
        `font-family:${canvasFontFamily(element.fontFamily)}`,
        'font-weight:400', `text-align:${element.align}`, 'white-space:pre-wrap');
      content = escapeHtml(element.text);
    } else if (element.type === 'divider') {
      style.push(`background:${element.color}`);
    } else if (element.type === 'handwriting') {
      style.push(`background:${element.fillColor}`, `border-color:${element.borderColor}`,
        `border-width:${Math.max(1, element.borderWidthMm * scale)}px`, `border-radius:${element.radiusMm * scale}px`);
    } else if (element.type === 'image' || element.type === 'background') {
      const url = state.assetUrls.get(element.assetId);
      if (url) style.push(`background-image:url('${url}')`, `background-size:${element.fit}`);
    }
    const resize = editable() && !element.locked && selected
      ? '<span class="label-resize-handle" data-label-resize="true"></span>' : '';
    return `<div class="label-canvas-element${selected}${locked}" data-label-element-id="${element.id}" data-type="${element.type}" style="${style.join(';')}">${content}${resize}</div>`;
  }

  function renderLayers() {
    if (!state.schema) return;
    el('labelLayerList').innerHTML = state.schema.elements
      .slice()
      .sort((left, right) => right.zIndex - left.zIndex)
      .map((element) => `
        <button type="button" data-label-layer-id="${element.id}"
          class="${element.id === state.selectedElementId ? 'active' : ''}">
          <span>${TYPE_LABELS[element.type] || element.type}</span>
          <small>${element.linkedToQr ? '联动' : element.locked ? '锁定' : element.id}</small>
        </button>
      `).join('');
  }

  function setValue(id, value) {
    const target = el(id);
    if (target) target.value = value == null ? '' : value;
  }

  function renderProperties() {
    if (!state.schema) return;
    const canvas = state.schema.canvas;
    setValue('labelCanvasWidth', canvas.widthMm);
    setValue('labelCanvasHeight', canvas.heightMm);
    setValue('labelCanvasColor', canvas.backgroundColor);
    setValue('labelCanvasTopRadius', canvas.cornerRadiiMm.topLeft);
    setValue('labelCanvasBottomRadius', canvas.cornerRadiiMm.bottomLeft);
    const element = activeElement();
    el('labelElementProperties').classList.toggle('hidden', !element);
    if (!element) return;
    const linkedId = element.type === 'id' && element.linkedToQr === true;
    el('labelQrIdLinkNote').classList.toggle('hidden', !linkedId);
    setValue('labelElementX', element.xMm);
    setValue('labelElementY', element.yMm);
    setValue('labelElementWidth', element.widthMm);
    setValue('labelElementHeight', element.heightMm);
    setValue('labelElementZ', element.zIndex);
    el('labelElementLocked').checked = element.locked === true;
    const hasText = ['text'].includes(element.type);
    const hasFont = ['text', 'id'].includes(element.type);
    el('labelElementTextRow').classList.toggle('hidden', !hasText);
    el('labelElementFontRows').classList.toggle('hidden', !hasFont);
    setValue('labelElementText', element.text || '');
    setValue('labelElementFont', element.fontFamily || 'noto-sans-sc');
    setValue('labelElementFontSize', element.fontSizePt || 5.5);
    setValue('labelElementColor', element.color || '#111827');
    setValue('labelElementAlign', element.align || 'left');
    ['labelElementX', 'labelElementY', 'labelElementWidth', 'labelElementHeight'].forEach((id) => {
      el(id).disabled = linkedId || (id === 'labelElementHeight' && element.type === 'qr');
    });
    el('labelElementLocked').disabled = linkedId;
    el('labelElementFontSize').disabled = linkedId;
    el('labelElementAlign').disabled = linkedId;
    el('deleteLabelElementBtn').disabled = !editable() || ['qr', 'id'].includes(element.type);
  }

  function renderEditor() {
    setEditorAvailability();
    renderTemplateList();
    renderCanvas();
    renderLayers();
    renderProperties();
  }

  function markDirty() {
    state.dirty = true;
    message('草稿有未保存的修改。');
  }

  function selectElement(elementId) {
    state.selectedElementId = elementId;
    renderCanvas();
    renderLayers();
    renderProperties();
  }

  async function loadTemplates({ keepSelection = true } = {}) {
    const currentId = keepSelection && activeTemplate() ? activeTemplate().id : '';
    const data = await api('/label-templates');
    state.templates = data.templates;
    renderTemplateList();
    if (currentId && state.templates.some((template) => template.id === currentId)) {
      await openTemplate(currentId);
    }
  }

  async function openTemplate(templateId) {
    if (state.dirty && !window.confirm('当前草稿尚未保存，确定切换模板吗？')) return;
    state.detail = await api(`/label-templates/${templateId}`);
    const version = draftVersion() || state.detail.versions.find(
      (item) => item.id === state.detail.template.current_published_version_id
    );
    state.schema = version ? clone(version.template_schema) : null;
    state.selectedElementId = state.schema && state.schema.elements[0]
      ? state.schema.elements[0].id : '';
    state.dirty = false;
    await loadAssetUrls();
    renderEditor();
    message('');
  }

  async function createTemplate() {
    const name = String(el('labelTemplateName').value || '').trim();
    if (!name) throw new Error('请输入模板名称。');
    const data = await api('/label-templates', {
      method: 'POST', body: JSON.stringify({ name })
    });
    el('labelTemplateName').value = '';
    await loadTemplates({ keepSelection: false });
    await openTemplate(data.template.id);
    message('模板已创建，可开始编辑。');
  }

  async function saveDraft({ quiet = false } = {}) {
    if (!editable()) throw new Error('当前模板没有可编辑草稿。');
    syncCanvasPropertiesFromControls();
    syncElementPropertiesFromControls();
    await api(`/label-templates/${activeTemplate().id}/draft`, {
      method: 'PUT', body: JSON.stringify({ schema: state.schema })
    });
    state.dirty = false;
    if (!quiet) message('草稿已保存。');
    await openTemplate(activeTemplate().id);
  }

  async function previewTemplate() {
    const response = await fetch(`/api/admin/label-templates/${activeTemplate().id}/preview`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${localStorage.getItem('adminToken') || ''}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ schema: state.schema, qr_id: 'SSS00016' })
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.message || '服务端预览失败。');
    }
    const image = el('labelServerPreviewImage');
    if (image.dataset.url) URL.revokeObjectURL(image.dataset.url);
    image.dataset.url = URL.createObjectURL(await response.blob());
    image.src = image.dataset.url;
    el('labelServerPreviewDialog').classList.remove('hidden');
  }

  async function publishTemplate() {
    if (editable()) await saveDraft({ quiet: true });
    await api(`/label-templates/${activeTemplate().id}/publish`, { method: 'POST', body: '{}' });
    await loadTemplates();
    message('模板版本已发布并锁定。');
  }

  async function copyTemplate() {
    const name = window.prompt('新模板名称', `${activeTemplate().name} - 副本`);
    if (!name) return;
    const data = await api(`/label-templates/${activeTemplate().id}/copy`, {
      method: 'POST', body: JSON.stringify({ name })
    });
    state.dirty = false;
    await loadTemplates({ keepSelection: false });
    await openTemplate(data.template_id);
    message('模板已复制为独立草稿。');
  }

  async function createVersion() {
    await api(`/label-templates/${activeTemplate().id}/versions`, {
      method: 'POST', body: '{}'
    });
    await openTemplate(activeTemplate().id);
    message('已从当前发布版本创建新草稿。');
  }

  async function archiveTemplate() {
    if (!window.confirm('停用后不能继续编辑或用于新的印刷任务，确定停用吗？')) return;
    await api(`/label-templates/${activeTemplate().id}/archive`, {
      method: 'POST', body: '{}'
    });
    state.dirty = false;
    await loadTemplates();
    message('模板已停用。');
  }

  function nextElementId(prefix) {
    let index = 1;
    while (state.schema.elements.some((element) => element.id === `${prefix}-${index}`)) index += 1;
    return `${prefix}-${index}`;
  }

  function addElement(type, asset) {
    if (!editable()) return;
    const zIndex = Math.max(0, ...state.schema.elements.map((element) => element.zIndex)) + 1;
    const common = { id: nextElementId(type), type, xMm: 2, yMm: 28, widthMm: 16,
      heightMm: 6, zIndex, locked: false, opacity: 1 };
    const element = type === 'text'
      ? { ...common, text: '可编辑文字', fontFamily: 'noto-sans-sc', fontSizePt: 5.5,
        minFontSizePt: 5.5, color: '#6B7280', align: 'left', letterSpacing: 0 }
      : type === 'divider'
        ? { ...common, heightMm: 0.2, color: '#D7B467' }
        : type === 'handwriting'
          ? { ...common, heightMm: 20, fillColor: '#FFFFFF', borderColor: '#D8DDE4',
            borderWidthMm: 0.2, radiusMm: 1 }
          : { ...common, type: asset.asset_type === 'background' ? 'background' : 'image',
            assetId: asset.id, fit: asset.asset_type === 'background' ? 'cover' : 'contain',
            xMm: asset.asset_type === 'background' ? 0 : 2,
            yMm: asset.asset_type === 'background' ? 0 : 28,
            widthMm: asset.asset_type === 'background' ? state.schema.canvas.widthMm : 16,
            heightMm: asset.asset_type === 'background' ? state.schema.canvas.heightMm : 10,
            zIndex: asset.asset_type === 'background' ? 0 : zIndex };
    state.schema.elements.push(element);
    state.selectedElementId = element.id;
    markDirty();
    renderEditor();
  }

  async function uploadAsset() {
    const file = el('labelAssetFile').files[0];
    if (!file) throw new Error('请选择图片文件。');
    const form = new FormData();
    form.append('image', file);
    form.append('asset_type', el('labelAssetType').value);
    const asset = await api(`/label-templates/${activeTemplate().id}/assets`, {
      method: 'POST', body: form
    });
    state.detail.assets.push(asset);
    await loadAssetUrls();
    addElement('image', asset);
    el('labelAssetFile').value = '';
    message('图片已上传并加入草稿。');
  }

  function syncCanvasPropertiesFromControls() {
    const canvas = state.schema.canvas;
    canvas.widthMm = Number(el('labelCanvasWidth').value);
    canvas.heightMm = Number(el('labelCanvasHeight').value);
    canvas.backgroundColor = el('labelCanvasColor').value.toUpperCase();
    const top = Number(el('labelCanvasTopRadius').value);
    const bottom = Number(el('labelCanvasBottomRadius').value);
    canvas.cornerRadiiMm = { topLeft: top, topRight: top, bottomRight: bottom, bottomLeft: bottom };
  }

  function updateCanvasProperties() {
    if (!editable()) return;
    syncCanvasPropertiesFromControls();
    markDirty();
    renderCanvas();
  }

  function syncElementPropertiesFromControls() {
    const element = activeElement();
    if (!element) return;
    const linkedId = element.type === 'id' && element.linkedToQr === true;
    if (!linkedId) {
      element.xMm = Number(el('labelElementX').value);
      element.yMm = Number(el('labelElementY').value);
      element.widthMm = Number(el('labelElementWidth').value);
      element.heightMm = element.type === 'qr'
        ? element.widthMm : Number(el('labelElementHeight').value);
      element.locked = el('labelElementLocked').checked;
    }
    element.zIndex = Number(el('labelElementZ').value);
    if (element.type === 'text') element.text = el('labelElementText').value;
    if (['text', 'id'].includes(element.type)) {
      element.fontFamily = el('labelElementFont').value;
      if (!linkedId) element.fontSizePt = Number(el('labelElementFontSize').value);
      element.minFontSizePt = Math.min(element.minFontSizePt || element.fontSizePt, element.fontSizePt);
      element.color = el('labelElementColor').value.toUpperCase();
      element.align = linkedId ? 'center' : el('labelElementAlign').value;
    }
    if (element.type === 'qr' || linkedId) synchronizeQrIdComponent();
  }

  function updateElementProperties() {
    if (!editable() || !activeElement()) return;
    syncElementPropertiesFromControls();
    markDirty();
    renderCanvas();
    renderLayers();
    if (activeElement().type === 'qr' || activeElement().linkedToQr === true) renderProperties();
  }

  function alignElement(direction) {
    const element = activeElement();
    if (!editable() || !element || element.locked) return;
    const canvas = state.schema.canvas;
    if (direction === 'left') element.xMm = 0;
    if (direction === 'center') element.xMm = snap((canvas.widthMm - element.widthMm) / 2);
    if (direction === 'right') element.xMm = canvas.widthMm - element.widthMm;
    if (direction === 'top') element.yMm = 0;
    if (direction === 'middle') element.yMm = snap((canvas.heightMm - element.heightMm) / 2);
    if (direction === 'bottom') element.yMm = canvas.heightMm - element.heightMm;
    if (element.type === 'qr') synchronizeQrIdComponent();
    markDirty();
    renderEditor();
  }

  function deleteElement() {
    const element = activeElement();
    if (!editable() || !element || ['qr', 'id'].includes(element.type)) return;
    state.schema.elements = state.schema.elements.filter((item) => item.id !== element.id);
    state.selectedElementId = state.schema.elements[0] ? state.schema.elements[0].id : '';
    markDirty();
    renderEditor();
  }

  function beginPointerEdit(event) {
    const target = event.target.closest('[data-label-element-id]');
    if (!target) return;
    selectElement(target.dataset.labelElementId);
    const element = activeElement();
    if (!editable() || !element || element.locked) return;
    event.preventDefault();
    const resizing = Boolean(event.target.closest('[data-label-resize]'));
    const scale = canvasScale();
    const start = { x: event.clientX, y: event.clientY, xMm: element.xMm, yMm: element.yMm,
      widthMm: element.widthMm, heightMm: element.heightMm };
    function move(moveEvent) {
      const dx = (moveEvent.clientX - start.x) / scale;
      const dy = (moveEvent.clientY - start.y) / scale;
      if (resizing) {
        element.widthMm = clamp(snap(start.widthMm + dx), 0.5,
          state.schema.canvas.widthMm - element.xMm);
        element.heightMm = clamp(snap(start.heightMm + dy), 0.2,
          state.schema.canvas.heightMm - element.yMm);
        if (element.type === 'qr') {
          const size = Math.max(10, Math.min(element.widthMm, element.heightMm));
          element.widthMm = size;
          element.heightMm = size;
        }
      } else {
        element.xMm = clamp(snap(start.xMm + dx), 0,
          state.schema.canvas.widthMm - element.widthMm);
        element.yMm = clamp(snap(start.yMm + dy), 0,
          state.schema.canvas.heightMm - element.heightMm);
      }
      if (element.type === 'qr') synchronizeQrIdComponent();
      state.dirty = true;
      renderCanvas();
      renderProperties();
    }
    function end() {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      message('草稿有未保存的修改。');
    }
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end, { once: true });
  }

  function bind() {
    if (state.loaded) return;
    state.loaded = true;
    el('createLabelTemplateBtn').addEventListener('click', () => run(createTemplate));
    el('refreshLabelTemplatesBtn').addEventListener('click', () => run(() => loadTemplates()));
    el('labelTemplateSearch').addEventListener('input', renderTemplateList);
    el('labelTemplateList').addEventListener('click', (event) => {
      const button = event.target.closest('[data-label-template-id]');
      if (button) run(() => openTemplate(button.dataset.labelTemplateId));
    });
    el('saveLabelTemplateBtn').addEventListener('click', () => run(() => saveDraft()));
    el('previewLabelTemplateBtn').addEventListener('click', () => run(previewTemplate));
    el('publishLabelTemplateBtn').addEventListener('click', () => run(publishTemplate));
    el('copyLabelTemplateBtn').addEventListener('click', () => run(copyTemplate));
    el('newLabelTemplateVersionBtn').addEventListener('click', () => run(createVersion));
    el('archiveLabelTemplateBtn').addEventListener('click', () => run(archiveTemplate));
    el('uploadLabelAssetBtn').addEventListener('click', () => run(uploadAsset));
    el('closeLabelPreviewBtn').addEventListener('click', () => {
      el('labelServerPreviewDialog').classList.add('hidden');
    });
    document.querySelectorAll('[data-label-editor-mode]').forEach((button) => {
      button.addEventListener('click', () => {
        document.querySelectorAll('[data-label-editor-mode]').forEach((item) => item.classList.toggle('active', item === button));
        document.querySelectorAll('[data-label-mode-panel]').forEach((panel) => panel.classList.toggle('hidden', panel.dataset.labelModePanel !== button.dataset.labelEditorMode));
      });
    });
    document.querySelectorAll('[data-add-label-element]').forEach((button) => {
      button.addEventListener('click', () => addElement(button.dataset.addLabelElement));
    });
    document.querySelectorAll('[data-label-align]').forEach((button) => {
      button.addEventListener('click', () => alignElement(button.dataset.labelAlign));
    });
    ['labelCanvasWidth', 'labelCanvasHeight', 'labelCanvasColor',
      'labelCanvasTopRadius', 'labelCanvasBottomRadius'].forEach((id) => {
      el(id).addEventListener('input', updateCanvasProperties);
    });
    ['labelElementX', 'labelElementY', 'labelElementWidth', 'labelElementHeight',
      'labelElementZ', 'labelElementText', 'labelElementFontSize', 'labelElementColor'].forEach((id) => {
      el(id).addEventListener('input', updateElementProperties);
    });
    ['labelElementLocked', 'labelElementFont', 'labelElementAlign'].forEach((id) => {
      el(id).addEventListener('change', updateElementProperties);
    });
    el('deleteLabelElementBtn').addEventListener('click', deleteElement);
    el('labelLayerList').addEventListener('click', (event) => {
      const button = event.target.closest('[data-label-layer-id]');
      if (button) selectElement(button.dataset.labelLayerId);
    });
    el('labelCanvas').addEventListener('pointerdown', beginPointerEdit);
  }

  async function run(callback) {
    try {
      message('');
      await callback();
    } catch (error) {
      const detail = Array.isArray(error.issues) && error.issues.length
        ? ` ${error.issues[0].message}` : '';
      message(`${error.message || '操作失败。'}${detail}`, true);
    }
  }

  async function load() {
    bind();
    await run(() => loadTemplates());
  }

  window.LabelTemplateEditor = Object.freeze({ load });
}());
