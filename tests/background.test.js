const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadBackground(fetchMock) {
  const code = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
  const sandbox = {
    console,
    fetch: fetchMock,
    TextEncoder,
    AbortController,
    setTimeout,
    clearTimeout,
    Promise,
    chrome: {
      runtime: { onMessage: { addListener() {} }, onInstalled: { addListener() {} } },
      storage: { local: { get(_keys, cb) { cb({}); }, set(_value, cb) { cb?.(); }, remove(_keys, cb) { cb?.(); } } }
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return sandbox;
}

function response(status, body) {
  return { status, ok: status >= 200 && status < 300, statusText: String(status), async json() { return body; } };
}

async function testLocalBatch() {
  const calls = [];
  const sandbox = loadBackground(async (url, options) => {
    calls.push({ url, options });
    return response(200, { translations: ['Xin chao', 'Tam biet'], latency_ms: 12 });
  });
  const result = await sandbox.translateBatch(['Hello', 'Goodbye'], { localUrl: 'http://127.0.0.1:8000/' });
  assert.deepStrictEqual(Array.from(result), ['Xin chao', 'Tam biet']);
  assert.strictEqual(calls[0].url, 'http://127.0.0.1:8000/translate');
}

async function testRetry() {
  let count = 0;
  const sandbox = loadBackground(async () => {
    count += 1;
    if (count === 1) throw new Error('network');
    return response(200, { translations: ['OK'], latency_ms: 1 });
  });
  const result = await sandbox.translateBatch(['Hello'], {});
  assert.strictEqual(result[0], 'OK');
  assert.strictEqual(count, 2);
}

async function testHealth() {
  const sandbox = loadBackground(async () => response(200, { ok: true, device: 'cuda' }));
  const result = await sandbox.checkLocalHealth();
  assert.strictEqual(result.device, 'cuda');
}

(async () => {
  await testLocalBatch();
  await testRetry();
  await testHealth();
  console.log('background.test.js passed');
})();
