// LoopFlow LAN companion. Run on the PC: node lan-server.js
// It keeps temporary room data in memory and serves this project to devices on the same LAN/hotspot.
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { networkInterfaces } from 'node:os';

const PORT = Number(process.env.LOOPFLOW_PORT || 3847);
const ROOT = process.cwd();
const TTL = 30 * 60 * 1000;
const MAX_BODY = 75 * 1024 * 1024; // 75 MB (allows 50 MB binary + base64 overhead)
const rooms = new Map();
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.pdf': 'application/pdf', '.zip': 'application/zip' };

function localAddress() {
  const candidates = [];
  for (const [name, interfaces] of Object.entries(networkInterfaces())) for (const item of interfaces || []) {
    if (item.family === 'IPv4' && !item.internal && !/virtual|vmware|hyper-v|vpn|loopback/i.test(name)) candidates.push(item.address);
  }
  return candidates.find(address => address.startsWith('192.168.137.'))
    || candidates.find(address => address.startsWith('192.168.'))
    || candidates.find(address => address.startsWith('10.'))
    || candidates.find(address => /^172\.(1[6-9]|2\d|3[01])\./.test(address))
    || candidates[0]
    || '127.0.0.1';
}
function json(response, status, body) { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' }); response.end(JSON.stringify(body)); }
function broadcast(room, type, payload) { for (const client of room.clients) client.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`); }
function snapshot(room) { return { roomId: room.id, expiresAt: room.expiresAt, lifetimeMinutes: room.lifetimeMinutes, activeUsers: room.activeUsers, messages: room.messages, files: room.files }; }
function getRoom(id, response) { const room = rooms.get(id); if (!room || room.expiresAt <= Date.now()) { if (room) rooms.delete(id); json(response, 404, { error: 'This local room has expired.' }); return null; } return room; }
function body(request) { return new Promise((resolve, reject) => { let raw = ''; request.on('data', chunk => { raw += chunk; if (raw.length > MAX_BODY) reject(new Error('File is too large for this temporary room.')); }); request.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new Error('Invalid request.')); } }); request.on('error', reject); }); }

const server = http.createServer(async (request, response) => {
  if (request.method === 'OPTIONS') { response.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' }); return response.end(); }
  const url = new URL(request.url, `http://${request.headers.host}`);
  try {
    if (url.pathname === '/api/health') return json(response, 200, { mode: 'lan', address: localAddress(), port: PORT });
    if (url.pathname === '/api/rooms' && request.method === 'POST') {
      let id; do { id = String(Math.floor(100000 + Math.random() * 900000)); } while (rooms.has(id));
      const data = await body(request);
      const lifetimeMinutes = Math.min(120, Math.max(10, Number(data.lifetimeMinutes) || 30));
      const room = { id, expiresAt: Date.now() + lifetimeMinutes * 60 * 1000, lifetimeMinutes, activeUsers: 1, messages: [], files: [], clients: new Set() };
      rooms.set(id, room); return json(response, 201, { ...snapshot(room), address: localAddress(), port: PORT });
    }
    const match = url.pathname.match(/^\/api\/rooms\/(\d{6})(?:\/(messages|files|events|clear))?$/);
    if (match) {
      const room = getRoom(match[1], response); if (!room) return;
      const action = match[2];
      if (!action && request.method === 'GET') { if (url.searchParams.get('join') === '1') room.activeUsers = Math.max(room.activeUsers, 2); broadcast(room, 'room', snapshot(room)); return json(response, 200, snapshot(room)); }
      if (!action && request.method === 'DELETE') { broadcast(room, 'expired', { status: 'deleted' }); rooms.delete(match[1]); return json(response, 200, { success: true }); }
      if (action === 'clear' && request.method === 'POST') { room.messages = []; room.files = []; broadcast(room, 'room', snapshot(room)); return json(response, 200, snapshot(room)); }
      if (action === 'events' && request.method === 'GET') {
        response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'Access-Control-Allow-Origin': '*' });
        room.clients.add(response); response.write(`event: room\ndata: ${JSON.stringify(snapshot(room))}\n\n`); request.on('close', () => { if (!room.clients.delete(response)) return; room.activeUsers = Math.max(1, room.activeUsers - 1); broadcast(room, 'room', snapshot(room)); }); return;
      }
      const data = await body(request);
      if (action === 'messages' && request.method === 'POST') { const message = data.message && typeof data.message === 'object' ? data.message : { type: 'text', content: String(data.content || '').slice(0, 10000) }; room.messages.push({ ...message, id: crypto.randomUUID(), senderId: data.senderId || 'local', senderName: data.senderName || 'Device', createdAt: Date.now() }); broadcast(room, 'room', snapshot(room)); return json(response, 201, snapshot(room)); }
      if (action === 'files' && request.method === 'POST') { const file = { id: crypto.randomUUID(), fileName: String(data.name || 'file'), filePath: String(data.path || data.name || 'file'), fileType: String(data.type || ''), fileSize: Number(data.size || 0), fileURL: data.data, senderId: data.senderId || 'local', uploadedAt: Date.now() }; room.files.unshift(file); room.messages.push({ ...file, senderName: data.senderName || 'Device', type: 'file', createdAt: Date.now() }); broadcast(room, 'room', snapshot(room)); return json(response, 201, snapshot(room)); }
    }
    const relative = url.pathname === '/' ? 'index.html' : url.pathname === '/chat' ? 'chat.html' : url.pathname.slice(1);
    const filePath = normalize(join(ROOT, relative)); if (!filePath.startsWith(ROOT)) return json(response, 403, { error: 'Not found.' });
    await stat(filePath); response.writeHead(200, { 'Content-Type': mime[extname(filePath)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); createReadStream(filePath).pipe(response);
  } catch (error) { json(response, error.message.includes('large') ? 413 : 400, { error: error.message || 'Request failed.' }); }
});
server.listen(PORT, '0.0.0.0', () => console.log(`LoopFlow LAN is ready: http://${localAddress()}:${PORT}`));
setInterval(() => { const now = Date.now(); for (const [id, room] of rooms) if (room.expiresAt <= now) { broadcast(room, 'expired', {}); rooms.delete(id); } }, 60_000).unref();
