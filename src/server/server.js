const express = require('express');
const path = require('path');
const { initializeDB } = require('./services/dbService');

const userRoutes = require('./routes/user');
const qrRoutes = require('./routes/qr');
const uploadRoutes = require('./routes/upload');

const app = express();
const PORT = process.env.PORT || 3000;

initializeDB();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use('/uploads', express.static(path.join(__dirname, 'public', 'uploads')));
app.use(express.static(path.join(__dirname, '..', 'frontend')));

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'frontend', 'index.html'));
});

app.use('/api/user', userRoutes);
app.use('/api/qr', qrRoutes);
app.use('/api/upload', uploadRoutes);

app.use((err, _req, res, _next) => {
  if (err.message === '仅支持图片文件上传') {
    return res.status(400).json({
      status: 'error',
      code: 'UPLOAD_FAILED',
      message: '仅支持图片格式，请重新选择。'
    });
  }

  return res.status(500).json({
    status: 'error',
    code: 'INTERNAL_ERROR',
    message: '系统开小差了，请稍后再试。'
  });
});

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Server started: http://localhost:${PORT}`);
});
