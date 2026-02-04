const WebSocket = require('ws');
const http = require('http');
const url = require('url');

// Railway provides PORT; fallback to 8080 for local
const PORT = process.env.PORT || 8080;
let registry = new Map();

const server = http.createServer((req, res) => {
    // Health Checks
    if (req.url === '/healthz' || req.url === '/status/health') {
        res.writeHead(200);
        return res.end('OK');
    }

    if (req.url === '/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
            connections: wss.clients.size,
            registrySize: registry.size,
            uptime: process.uptime()
        }));
    }

    // Dashboard
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`
        <html>
            <body style="background:#000;color:#ff9800;font-family:monospace;padding:20px;">
                <h1>PRESENCE_CORE // PRODUCTION</h1>
                <p>STATUS: ONLINE</p>
                <p>ACTIVE_SOCKETS: ${wss.clients.size}</p>
                <p>REGISTRY_ENTRIES: ${registry.size}</p>
            </body>
        </html>
    `);
});

const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
    // Extract address via Query Parameter
    const parameters = url.parse(req.url, true).query;
    const addressId = parameters.address;

    if (!addressId) {
        console.log("Connection Rejected: No addressId provided.");
        return ws.close();
    }

    ws.locusAddress = addressId;
    console.log(`Peer connected to Locus: ${addressId}`);

    // Perfect Negotiation Role Assignment
    const peers = Array.from(wss.clients).filter(c => 
        c !== ws && c.locusAddress === addressId && c.readyState === WebSocket.OPEN
    );

    if (peers.length > 0) {
        // Person joining is initiator (impolite), person waiting is polite
        ws.send(JSON.stringify({ type: 'ready', role: 'initiator' }));
        peers[0].send(JSON.stringify({ type: 'ready', role: 'polite' }));
    }

    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data);

            if (msg.type === 'ping') {
                return ws.send(JSON.stringify({ type: 'pong' }));
            }

            if (msg.type === 'reserve_request') {
                registry.set(msg.address, { 
                    id: msg.address, 
                    nickname: msg.nickname, 
                    expiresAt: Date.now() + (msg.hours * 3600000)
                });
                return;
            }

            // Relay everything else to the room
            wss.clients.forEach(client => {
                if (client.locusAddress === addressId && client !== ws && client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify(msg));
                }
            });
        } catch (e) {
            console.error("Relay Error:", e);
        }
    });

    ws.on('close', () => console.log(`Peer left Locus: ${addressId}`));
    ws.on('error', (err) => console.error("Socket Error:", err.message));
});

// Registry Cleanup Loop (Every 5 mins)
setInterval(() => {
    const now = Date.now();
    registry.forEach((v, k) => { if (v.expiresAt < now) registry.delete(k); });
}, 300000);

server.listen(PORT, '0.0.0.0', () => console.log(`PRESENCE_CORE LIVE ON PORT ${PORT}`));
