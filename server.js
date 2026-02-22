// Load environment variables from .env file (must be before any imports)
// Only set if not already defined (allows command-line override)
const path = require('path');
const fs = require('fs');
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  const envLines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const line of envLines) {
    const match = line.match(/^([^=]+)=(.*)$/);
    if (match && !match[1].startsWith('#')) {
      const key = match[1].trim();
      if (process.env[key] === undefined) {
        process.env[key] = match[2].trim();
      }
    }
  }
}

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const os = require('os');
const { setupSocketHandlers } = require('./server/socketHandlers');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingTimeout: 30000,
  pingInterval: 10000
});

app.use(express.static(path.join(__dirname, 'public')));

setupSocketHandlers(io);

const PORT = process.env.PORT || 3000;

function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

server.listen(PORT, '0.0.0.0', () => {
  const localIP = getLocalIP();
  console.log('='.repeat(50));
  console.log('  局域网德州扑克游戏服务器已启动!');
  console.log('='.repeat(50));
  console.log(`  本机访问: http://localhost:${PORT}`);
  console.log(`  局域网访问: http://${localIP}:${PORT}`);
  console.log('='.repeat(50));
});
