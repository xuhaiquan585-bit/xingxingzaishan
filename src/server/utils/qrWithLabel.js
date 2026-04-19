/**
 * qrWithLabel.js
 * 在二维码 PNG 下方拼接序号文字条，输出新 PNG Buffer。
 * 纯 JS 实现，仅依赖 pngjs（无原生编译），一次成型。
 */

const { PNG } = require('pngjs');

/* ── 5×7 点阵字体（ASCII 0x20~0x5F，即空格、数字、大写字母及常用符号） ── */
const FONT = {};
// 辅助：将 7 行十六进制字符串转为 7×5 二维 0/1 数组
function g(lines) { return lines.map(h => { const r = []; for (let i = 4; i >= 0; i--) r.push((h >> i) & 1); return r; }); }
// 每个字符 7 行，每行 5 bit
FONT['0'] = g([0x0E,0x11,0x13,0x15,0x19,0x11,0x0E]);
FONT['1'] = g([0x04,0x0C,0x04,0x04,0x04,0x04,0x0E]);
FONT['2'] = g([0x0E,0x11,0x01,0x02,0x04,0x08,0x1F]);
FONT['3'] = g([0x0E,0x11,0x01,0x06,0x01,0x11,0x0E]);
FONT['4'] = g([0x02,0x06,0x0A,0x12,0x1F,0x02,0x02]);
FONT['5'] = g([0x1F,0x10,0x1E,0x01,0x01,0x11,0x0E]);
FONT['6'] = g([0x06,0x08,0x10,0x1E,0x11,0x11,0x0E]);
FONT['7'] = g([0x1F,0x01,0x02,0x04,0x08,0x08,0x08]);
FONT['8'] = g([0x0E,0x11,0x11,0x0E,0x11,0x11,0x0E]);
FONT['9'] = g([0x0E,0x11,0x11,0x0F,0x01,0x02,0x0C]);
FONT['A'] = g([0x0E,0x11,0x11,0x1F,0x11,0x11,0x11]);
FONT['B'] = g([0x1E,0x11,0x11,0x1E,0x11,0x11,0x1E]);
FONT['C'] = g([0x0E,0x11,0x10,0x10,0x10,0x11,0x0E]);
FONT['D'] = g([0x1E,0x11,0x11,0x11,0x11,0x11,0x1E]);
FONT['E'] = g([0x1F,0x10,0x10,0x1E,0x10,0x10,0x1F]);
FONT['F'] = g([0x1F,0x10,0x10,0x1E,0x10,0x10,0x10]);
FONT['G'] = g([0x0E,0x11,0x10,0x17,0x11,0x11,0x0F]);
FONT['H'] = g([0x11,0x11,0x11,0x1F,0x11,0x11,0x11]);
FONT['I'] = g([0x0E,0x04,0x04,0x04,0x04,0x04,0x0E]);
FONT['J'] = g([0x07,0x02,0x02,0x02,0x12,0x12,0x0C]);
FONT['K'] = g([0x11,0x12,0x14,0x18,0x14,0x12,0x11]);
FONT['L'] = g([0x10,0x10,0x10,0x10,0x10,0x10,0x1F]);
FONT['M'] = g([0x11,0x1B,0x15,0x15,0x11,0x11,0x11]);
FONT['N'] = g([0x11,0x19,0x15,0x13,0x11,0x11,0x11]);
FONT['O'] = g([0x0E,0x11,0x11,0x11,0x11,0x11,0x0E]);
FONT['P'] = g([0x1E,0x11,0x11,0x1E,0x10,0x10,0x10]);
FONT['Q'] = g([0x0E,0x11,0x11,0x11,0x15,0x12,0x0D]);
FONT['R'] = g([0x1E,0x11,0x11,0x1E,0x14,0x12,0x11]);
FONT['S'] = g([0x0E,0x11,0x10,0x0E,0x01,0x11,0x0E]);
FONT['T'] = g([0x1F,0x04,0x04,0x04,0x04,0x04,0x04]);
FONT['U'] = g([0x11,0x11,0x11,0x11,0x11,0x11,0x0E]);
FONT['V'] = g([0x11,0x11,0x11,0x11,0x0A,0x0A,0x04]);
FONT['W'] = g([0x11,0x11,0x11,0x15,0x15,0x1B,0x11]);
FONT['X'] = g([0x11,0x11,0x0A,0x04,0x0A,0x11,0x11]);
FONT['Y'] = g([0x11,0x11,0x0A,0x04,0x04,0x04,0x04]);
FONT['Z'] = g([0x1F,0x01,0x02,0x04,0x08,0x10,0x1F]);
FONT['-'] = g([0x00,0x00,0x00,0x1F,0x00,0x00,0x00]);
FONT[' '] = g([0x00,0x00,0x00,0x00,0x00,0x00,0x00]);

/**
 * 在二维码 PNG Buffer 下方加序号文字条，返回新 PNG Buffer。
 * @param {Buffer} qrPngBuf - QRCode.toBuffer() 输出的 PNG
 * @param {string} label    - 序号文字，如 "OSSC00001"
 * @param {object} [opts]
 * @param {number} [opts.scale=3]     - 字体放大倍数（1=5px宽，3=15px宽/字符）
 * @param {number} [opts.paddingY=12] - 文字条上下留白 (px)
 * @param {number} [opts.bgR=255]     - 背景色 RGB
 * @param {number} [opts.bgG=255]
 * @param {number} [opts.bgB=255]
 * @param {number} [opts.fgR=0]       - 前景色 RGB
 * @param {number} [opts.fgG=0]
 * @param {number} [opts.fgB=0]
 * @returns {Buffer} 合成后的 PNG Buffer
 */
function addLabelToQR(qrPngBuf, label, opts = {}) {
  const scale = opts.scale || 3;
  const paddingY = opts.paddingY != null ? opts.paddingY : 12;
  const bgR = opts.bgR != null ? opts.bgR : 255;
  const bgG = opts.bgG != null ? opts.bgG : 255;
  const bgB = opts.bgB != null ? opts.bgB : 255;
  const fgR = opts.fgR != null ? opts.fgR : 0;
  const fgG = opts.fgG != null ? opts.fgG : 0;
  const fgB = opts.fgB != null ? opts.fgB : 0;

  // 解码原始二维码 PNG
  const qrPng = PNG.sync.read(qrPngBuf);
  const qrW = qrPng.width;
  const qrH = qrPng.height;

  // 计算文字尺寸
  const charW = 5 * scale;
  const charH = 7 * scale;
  const gap = 1 * scale; // 字符间距
  const textW = label.length * charW + (label.length - 1) * gap;

  // 新图尺寸 = 原二维码 + 文字条
  const labelH = charH + paddingY * 2;
  const totalW = Math.max(qrW, textW + 20); // 左右至少留 10px
  const totalH = qrH + labelH;

  // 创建新 PNG
  const outPng = new PNG({ width: totalW, height: totalH });
  const outData = outPng.data;

  // 填充背景色（全部像素）
  for (let i = 0; i < outData.length; i += 4) {
    outData[i]     = bgR;
    outData[i + 1] = bgG;
    outData[i + 2] = bgB;
    outData[i + 3] = 255;
  }

  // 居中偏移
  const qrOffX = Math.floor((totalW - qrW) / 2);

  // 拷贝二维码像素到新图
  for (let y = 0; y < qrH; y++) {
    for (let x = 0; x < qrW; x++) {
      const srcIdx = (qrW * y + x) << 2;
      const dstX = qrOffX + x;
      const dstIdx = (totalW * y + dstX) << 2;
      outData[dstIdx]     = qrPng.data[srcIdx];
      outData[dstIdx + 1] = qrPng.data[srcIdx + 1];
      outData[dstIdx + 2] = qrPng.data[srcIdx + 2];
      outData[dstIdx + 3] = qrPng.data[srcIdx + 3];
    }
  }

  // 绘制文字（居中，在二维码下方）
  const textOffX = Math.floor((totalW - textW) / 2);
  const textOffY = qrH + paddingY;

  for (let ci = 0; ci < label.length; ci++) {
    const ch = label[ci].toUpperCase();
    const glyph = FONT[ch];
    if (!glyph) continue; // 跳过未知字符

    const charOffX = textOffX + ci * (charW + gap);

    for (let row = 0; row < 7; row++) {
      for (let col = 0; col < 5; col++) {
        if (glyph[row][col]) {
          // 绘制 scale×scale 的像素块
          for (let sy = 0; sy < scale; sy++) {
            for (let sx = 0; sx < scale; sx++) {
              const px = charOffX + col * scale + sx;
              const py = textOffY + row * scale + sy;
              if (px >= 0 && px < totalW && py >= 0 && py < totalH) {
                const idx = (totalW * py + px) << 2;
                outData[idx]     = fgR;
                outData[idx + 1] = fgG;
                outData[idx + 2] = fgB;
                outData[idx + 3] = 255;
              }
            }
          }
        }
      }
    }
  }

  return PNG.sync.write(outPng);
}

module.exports = { addLabelToQR };
