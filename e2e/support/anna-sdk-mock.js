// Stand-in for Anna's `/static/anna-apps/_sdk/latest/index.js` in E2E tests.
//
// Same surface the app uses (llm / storage / upload / image / window), and the
// same failure shape as the real SDK: a rejected call is a plain `Error` with
// `.code`. Every call is forwarded to the test process (Playwright route on
// `/__anna_rpc`), which plays the Anna host.

async function call(ns, method, args) {
  const res = await fetch('/__anna_rpc', {
    method: 'POST',
    // text/plain keeps this a "simple" CORS request from the opaque-origin iframe.
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify({ ns, method, args }),
  });
  const reply = await res.json();
  if (reply.reject) {
    const err = new Error(reply.reject.message);
    if (reply.reject.code) err.code = reply.reject.code;
    throw err;
  }
  return reply.value;
}

const rt = {
  llm: { complete: (args) => call('llm', 'complete', args) },
  storage: {
    get: (args) => call('storage', 'get', args),
    set: (args) => call('storage', 'set', args),
    delete: (args) => call('storage', 'delete', args),
    list: (args) => call('storage', 'list', args),
  },
  upload: {
    inline: (args) => call('upload', 'inline', args),
    confirm: (args) => call('upload', 'confirm', args),
  },
  image: { generate: (args) => call('image', 'generate', args) },
  window: { report_error: (args) => call('window', 'report_error', args) },
  theme: 'light',
  locale: 'en',
};

export const AnnaAppRuntime = {
  async connect() {
    await call('runtime', 'connect', {});
    return rt;
  },
};
