import fs from 'node:fs';
const api = 'http://localhost:8931';
const b64 = (p) => fs.readFileSync(p).toString('base64');
const before = (await (await fetch(`${api}/api/credits`)).json()).units;
// upload person once (reused later by the app)
const up = await (await fetch(`${api}/api/upload`, { method: 'POST', headers: {'Content-Type':'application/json'},
  body: JSON.stringify({ imageBase64: b64('public/samples/person.png'), mime: 'image/png', name: 'person.png' }) })).json();
console.log('person fileId:', (up.fileId||'').slice(0,20)+'...');
const start = await (await fetch(`${api}/api/vto/start`, { method: 'POST', headers: {'Content-Type':'application/json'},
  body: JSON.stringify({ personFileId: up.fileId, garmentBase64: b64('public/samples/garment_dress.png'), mime: 'image/png', category: 'full_body' }) })).json();
console.log('task:', JSON.stringify(start).slice(0,200));
if (!start.taskId) process.exit(1);
let st;
for (let i = 0; i < 60; i++) {
  await new Promise(r => setTimeout(r, 4000));
  st = await (await fetch(`${api}/api/vto/status/${encodeURIComponent(start.taskId)}`)).json();
  process.stdout.write(`poll ${i}: ${st.status}\n`);
  if (st.status !== 'running') break;
}
if (st.status === 'success') {
  const img = await fetch(st.url);
  fs.writeFileSync('/tmp/vto_result.jpg', Buffer.from(await img.arrayBuffer()));
  console.log('RESULT saved /tmp/vto_result.jpg', fs.statSync('/tmp/vto_result.jpg').size, 'bytes');
} else console.log('ERROR:', JSON.stringify(st));
const after = (await (await fetch(`${api}/api/credits`)).json()).units;
console.log(`credits: ${before} -> ${after} (cost ${before - after})`);
