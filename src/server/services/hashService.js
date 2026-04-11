function generateMockBlockchainHash() {
  const minLength = 16;
  const maxLength = 32;
  const length = Math.floor(Math.random() * (maxLength - minLength + 1)) + minLength;
  const chars = 'abcdef0123456789';
  let value = '';

  for (let i = 0; i < length; i += 1) {
    value += chars.charAt(Math.floor(Math.random() * chars.length));
  }

  return `0x${value}`;
}

module.exports = { generateMockBlockchainHash };
