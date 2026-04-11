const express = require('express');
const { createOrGetUser } = require('../services/dbService');

const router = express.Router();

function isValidPhone(phone) {
  return /^1\d{10}$/.test(phone);
}

router.post('/login', (req, res) => {
  const { phone } = req.body;
  if (!phone || !isValidPhone(phone)) {
    return res.status(400).json({
      status: 'error',
      code: 'INVALID_PHONE',
      message: '手机号格式不正确，请检查后重试。'
    });
  }

  const user = createOrGetUser(phone);
  return res.json({
    status: 'success',
    code: 'OK',
    data: {
      id: user.id,
      phone: user.phone,
      created_at: user.created_at
    }
  });
});

module.exports = router;
