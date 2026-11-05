'use strict';
// Starts a mock OpenAI-compatible provider plus the DayFlow server for browser tests. Test use only.
const http = require('http'), fs = require('fs'), os = require('os'), path = require('path');
const { loadConfig, createServer } = require('../server/index');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const mock = http.createServer((req, res) => {
  let body = ''; req.on('data', d => body += d); req.on('end', async () => {
    if (req.headers.authorization !== 'Bearer good-key') { res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{"error":"bad key"}'); }
    if (req.url === '/v1/models') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ data: ['deepseek-v4.1', 'other-model', 'slow-model'].map(id => ({ id })) })); }
    if (req.url === '/v1/chat/completions') {
      const b = JSON.parse(body), words = `Mock reply from ${b.model}. `.repeat(b.model === 'slow-model' ? 12 : 1).split(' ');
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const w of words) { res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: w + ' ' } }] }) + '\n\n'); await sleep(b.model === 'slow-model' ? 250 : 15); if (res.destroyed) return; }
      res.write('data: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 8 } }) + '\n\n'); return res.end('data: [DONE]\n\n');
    }
    res.writeHead(404); res.end();
  });
});
mock.listen(0, '127.0.0.1', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dayflow-e2e-'));
  const cfg = loadConfig({ DAYFLOW_DATA_DIR: dir, DAYFLOW_ALLOW_HTTP: '1', DAYFLOW_ALLOW_PRIVATE: '1', DAYFLOW_DEV_RESET: '1' });
  const srv = createServer(cfg); srv.listen(0, '127.0.0.1', () => console.log(JSON.stringify({ app: srv.address().port, mock: mock.address().port, dir })));
});
