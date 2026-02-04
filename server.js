const WebSocket = require('ws');
const http = require('http');
const url = require('url');

const PORT = process.env.PORT || 8080;

const server = http.createServer((req, res) => {
    if (req.url === '/healthz') {
        res.writeHead(200);
        return res.end('OK');
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<body style="background:#000;color:#0f0;font-family:monospace;padding:20px;"><h1>PRESENCE_CORE // ONLINE</h1></body>');
});

const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
    try {
        const parameters = url.parse(req.url, true).query;
        const addressId = parameters.address;

        if (!addressId) {
            console.log("Rejected: No Address");
            return ws.terminate();
        }

        ws.locusAddress = addressId;
        ws.isAlive = true;
        
        // Setup Heartbeat to prevent mobile carrier timeout
        ws.on('pong', () => { ws.isAlive = true; });

        const peers = Array.from(wss.clients).filter(c => 
            c !== ws && c.locusAddress === addressId && c.readyState === WebSocket.OPEN
        );

        if (peers.length > 0) {
            // Role assignment for WebRTC Perfect Negotiation
            ws.send(JSON.stringify({ type: 'ready', role: 'initiator' }));
            peers[0].send(JSON.stringify({ type: 'ready', role: 'polite' }));
        }

        ws.on('message', (message) => {
            try {
                const msg = JSON.parse(message);
                if (msg.type === 'ping') return ws.send(JSON.stringify({ type: 'pong' }));

                wss.clients.forEach(client => {
                    if (client.locusAddress === addressId && client !== ws && client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify(msg));
                    }
                });
            } catch (e) { console.error("Broadcast Error"); }
        });

    } catch (e) {
        console.error("Handshake Error", e);
        ws.terminate();
    }
});

// Reaping dead connections every 30 seconds
const interval = setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);

server.listen(PORT, '0.0.0.0', () => console.log(`SERVER LIVE ON PORT ${PORT}`));
