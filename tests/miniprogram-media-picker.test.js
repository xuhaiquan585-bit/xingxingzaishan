const test = require('node:test');
const assert = require('node:assert/strict');

const {
  chooseSingleImage,
  imageSelectionErrorMessage,
  isImageSelectionCancelled,
  requirePrivacyAuthorization
} = require('../src/miniprogram/utils/media');

test('media picker requests privacy authorization before choosing an image', async () => {
  const calls = [];
  const file = { tempFilePath: 'wxfile://photo.jpg', width: 100, height: 80 };
  const selected = await chooseSingleImage({
    requirePrivacyAuthorize({ success }) {
      calls.push('privacy');
      success();
    },
    chooseMedia({ count, mediaType, sourceType, success }) {
      calls.push('choose');
      assert.equal(count, 1);
      assert.deepEqual(mediaType, ['image']);
      assert.deepEqual(sourceType, ['album', 'camera']);
      success({ tempFiles: [file] });
    }
  });
  assert.deepEqual(calls, ['privacy', 'choose']);
  assert.equal(selected, file);
});

test('media picker supports older bases without requirePrivacyAuthorize', async () => {
  const selected = await chooseSingleImage({
    chooseMedia({ success }) {
      success({ tempFiles: [{ tempFilePath: 'wxfile://legacy.jpg' }] });
    }
  });
  assert.equal(selected.tempFilePath, 'wxfile://legacy.jpg');
});

test('privacy rejection stops before chooseMedia', async () => {
  let chooseCalled = false;
  const rejection = { errMsg: 'requirePrivacyAuthorize:fail privacy permission is not authorized' };
  await assert.rejects(
    chooseSingleImage({
      requirePrivacyAuthorize({ fail }) {
        fail(rejection);
      },
      chooseMedia() {
        chooseCalled = true;
      }
    }),
    (error) => error === rejection
  );
  assert.equal(chooseCalled, false);
});

test('chooseMedia rejection is preserved for user feedback', async () => {
  const rejection = { errMsg: 'chooseMedia:fail api scope is not declared in the privacy agreement' };
  await assert.rejects(
    chooseSingleImage({
      chooseMedia({ fail }) {
        fail(rejection);
      }
    }),
    (error) => error === rejection
  );
});

test('missing selected file fails closed', async () => {
  await assert.rejects(
    chooseSingleImage({
      chooseMedia({ success }) {
        success({ tempFiles: [] });
      }
    }),
    /No image was selected/
  );
});

test('selection cancellation is distinguished from permission failures', () => {
  assert.equal(isImageSelectionCancelled({ errMsg: 'chooseMedia:fail cancel' }), true);
  assert.equal(isImageSelectionCancelled({ errMsg: 'chooseMedia:fail auth deny' }), false);
  assert.match(
    imageSelectionErrorMessage({ errMsg: 'chooseMedia:fail privacy permission is not authorized' }),
    /隐私保护指引/
  );
  assert.match(
    imageSelectionErrorMessage({ errMsg: 'chooseMedia:fail system error' }),
    /系统权限/
  );
});

test('privacy authorization helper resolves when the API is unavailable', async () => {
  await requirePrivacyAuthorization({});
});
