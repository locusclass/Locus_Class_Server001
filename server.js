const WebSocket = require('ws');
const http = require('http');

// Render provides the PORT env var; fallback to 8080 for local dev
const PORT = process.env.PORT || 8080;
let registry = new Map();

const server = http.createServer((req, res) => {
    // Health Check for Render's zero-downtime deploys
    if (req.url === '/healthz' || req.url === '/status/health') {
        res.writeHead(200);
        return res.end('OK');
    }

    if (req.url === '/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        const status = {
            connections: wss.clients.size,
            registrySize: registry.size,
            uptime: process.uptime()
        };
        return res.end(JSON.stringify(status));
    }

    // Basic Dashboard
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`
        <html>
            <body style="background:#000;color:#0f0;font-family:monospace;padding:20px;">
                <h1>PRESENCE_CORE // STATUS: ONLINE</h1>
                <p>ACTIVE_SOCKETS: ${wss.clients.size}</p>
                <p>REGISTRY_ENTRIES: ${registry.size}</p>
            </body>
        </html>
    `);
});

const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
    const addressId = req.headers['sec-websocket-protocol'];
    if (!addressId) return ws.close();

    // Determine Roles
    const peers = Array.from(wss.clients).filter(c => 
        c !== ws && c.protocol === addressId && c.readyState === WebSocket.OPEN
    );

    if (peers.length > 0) {
        ws.send(JSON.stringify({ type: 'ready', role: 'initiator' }));
        peers[0].send(JSON.stringify({ type: 'ready', role: 'polite' }));
    }

    ws.on('message', (message) => {
        try {
            const msg = JSON.parse(message);
            if (msg.type === 'reserve_request') {
                registry.set(msg.address, { 
                    id: msg.address, 
                    nickname: msg.nickname, 
                    expiresAt: Date.now() + (msg.hours * 3600000),
                    isPersistent: true 
                });
            } else if (msg.type === 'ping') {
                ws.send(JSON.stringify({ type: 'pong' }));
            } else {
                // RELAY WebRTC/Text/Hold
                wss.clients.forEach(client => {
                    if (client.protocol === addressId && client !== ws && client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify(msg));
                    }
                });
            }
        } catch (e) { console.error("Relay Error", e); }
    });
});

// Registry Cleanup Loop
setInterval(() => {
    const now = Date.now();
    registry.forEach((v, k) => { if (v.expiresAt < now) registry.delete(k); });
}, 300000);

server.listen(PORT, '0.0.0.0', () => console.log(`PRESENCE SERVER LIVE ON PORT ${PORT}`));
