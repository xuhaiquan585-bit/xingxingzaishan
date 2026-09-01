'use strict';

const multer = require('multer');
const sharp = require('sharp');

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const MAX_INPUT_DIMENSION = 12000;
const MAX_INPUT_PIXELS = 50_000_000;
const ALLOWED_INPUT_FORMATS = new Set(['jpeg', 'png']);

class ImageUploadValidationError extends Error {
  constructor(code = 'UPLOAD_FAILED') {
    super(code);
    this.name = 'ImageUploadValidationError';
    this.code = code;
  }
}

function validationError(code = 'UPLOAD_FAILED') {
  return new ImageUploadValidationError(code);
}

function hasJpegSignature(buffer) {
  return buffer.length >= 3
    && buffer[0] === 0xff
    && buffer[1] === 0xd8
    && buffer[2] === 0xff;
}

function hasPngSignature(buffer) {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  return buffer.length >= signature.length
    && signature.every((byte, index) => buffer[index] === byte);
}

function hasAllowedImageSignature(buffer) {
  return hasJpegSignature(buffer) || hasPngSignature(buffer);
}

function assertSafeMetadata(metadata) {
  if (!metadata || !ALLOWED_INPUT_FORMATS.has(metadata.format)) {
    throw validationError();
  }
  const width = Number(metadata.width);
  const height = Number(metadata.height);
  const pages = Number(metadata.pages || 1);
  if (!Number.isInteger(width) || !Number.isInteger(height)
      || width < 1 || height < 1
      || width > MAX_INPUT_DIMENSION || height > MAX_INPUT_DIMENSION
      || !Number.isInteger(pages) || pages !== 1
      || width * height > MAX_INPUT_PIXELS) {
    throw validationError();
  }
  return { width, height, pages, format: metadata.format };
}

async function normalizeUploadedImage(file, {
  maxOutputWidth = 1080,
  jpegQuality = 80
} = {}) {
  if (!file || !Buffer.isBuffer(file.buffer)
      || file.buffer.length < 1 || file.buffer.length > MAX_UPLOAD_BYTES
      || !hasAllowedImageSignature(file.buffer)) {
    throw validationError();
  }
  if (!Number.isInteger(maxOutputWidth) || maxOutputWidth < 1 || maxOutputWidth > 4096
      || !Number.isInteger(jpegQuality) || jpegQuality < 1 || jpegQuality > 100) {
    throw validationError();
  }

  try {
    const metadata = await sharp(file.buffer, {
      failOn: 'error',
      limitInputPixels: MAX_INPUT_PIXELS,
      sequentialRead: true,
      animated: false
    }).metadata();
    assertSafeMetadata(metadata);

    const output = await sharp(file.buffer, {
      failOn: 'error',
      limitInputPixels: MAX_INPUT_PIXELS,
      sequentialRead: true,
      animated: false
    })
      .rotate()
      .toColorspace('srgb')
      .resize({ width: maxOutputWidth, withoutEnlargement: true })
      .flatten({ background: { r: 255, g: 255, b: 255 } })
      .jpeg({ quality: jpegQuality })
      .toBuffer({ resolveWithObject: true });

    if (!output || !Buffer.isBuffer(output.data) || output.data.length < 1
        || output.info.format !== 'jpeg') {
      throw validationError();
    }
    return Object.freeze({
      ...file,
      buffer: output.data,
      mimetype: 'image/jpeg',
      size: output.data.length,
      pixel_width: output.info.width,
      pixel_height: output.info.height
    });
  } catch (error) {
    if (error instanceof ImageUploadValidationError) throw error;
    throw validationError();
  }
}

const imageUploadParser = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_UPLOAD_BYTES,
    files: 1,
    fields: 8,
    parts: 10
  }
});

function receiveSingleImage(fieldName = 'image') {
  const receive = imageUploadParser.single(fieldName);
  return (req, res, next) => receive(req, res, (error) => {
    if (!error) return next();
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({
        status: 'error',
        code: 'UPLOAD_SIZE_EXCEEDED',
        message: '图片过大，请选择 5MB 以内的图片'
      });
    }
    return res.status(400).json({
      status: 'error',
      code: 'UPLOAD_FAILED',
      message: '上传失败，请重新选择图片。'
    });
  });
}

function respondToImageValidationError(error, res, message = '图片文件无法识别，请重新选择。') {
  if (!(error instanceof ImageUploadValidationError)) return false;
  res.status(400).json({
    status: 'error',
    code: 'UPLOAD_FAILED',
    message
  });
  return true;
}

module.exports = {
  ALLOWED_INPUT_FORMATS,
  ImageUploadValidationError,
  MAX_INPUT_DIMENSION,
  MAX_INPUT_PIXELS,
  MAX_UPLOAD_BYTES,
  assertSafeMetadata,
  hasAllowedImageSignature,
  normalizeUploadedImage,
  receiveSingleImage,
  respondToImageValidationError
};
