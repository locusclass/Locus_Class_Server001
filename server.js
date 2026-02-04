const WebSocket = require('ws');
const http = require('http');
const url = require('url');

const PORT = process.env.PORT || 8080;

const server = http.createServer((req, res) => {
    // Health check for cloud environment stability
    if (req.url === '/healthz') { res.writeHead(200); return res.end('OK'); }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('PRESENCE_UNIVERSAL_CORE_V3_ACTIVE');
});

const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
    try {
        const parameters = url.parse(req.url, true).query;
        const addressId = parameters.address;

        if (!addressId) return ws.terminate();

        ws.locusAddress = addressId;
        ws.isAlive = true;

        // Grouping logic for 1-to-1 WebRTC sessions
        const peers = Array.from(wss.clients).filter(c => 
            c !== ws && c.locusAddress === addressId && c.readyState === WebSocket.OPEN
        );

        if (peers.length === 0) {
            ws.role = 'polite';
        } else if (peers.length === 1) {
            ws.role = 'initiator';
            // Explicitly signal roles to ensure Perfect Negotiation
            ws.send(JSON.stringify({ type: 'ready', role: 'initiator' }));
            peers[0].send(JSON.stringify({ type: 'ready', role: 'polite' }));
        } else {
            ws.send(JSON.stringify({ type: 'error', message: 'PEER_LIMIT_REACHED' }));
            return ws.terminate();
        }

        ws.on('pong', () => { ws.isAlive = true; });

        ws.on('message', (rawData) => {
            try {
                const msg = JSON.parse(rawData);
                // System-level heartbeat
                if (msg.type === 'ping') return ws.send(JSON.stringify({ type: 'pong' }));

                // Broadcaster relay
                wss.clients.forEach(client => {
                    if (client.locusAddress === addressId && client !== ws && client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify(msg));
                    }
                });
            } catch (e) { /* Ignore malformed packets */ }
        });

        ws.on('close', () => {
            wss.clients.forEach(client => {
                if (client.locusAddress === addressId && client !== ws) {
                    client.send(JSON.stringify({ type: 'collapse', reason: 'peer_lost' }));
                }
            });
        });

    } catch (e) { ws.terminate(); }
});

// The Reaper: Essential for mobile. Kills "ghost" sockets that Android kills without 
// sending a proper 'close' frame (common in app hibernation).
setInterval(() => {
    wss.clients.forEach((ws) => {
        if (!ws.isAlive) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
    });
}, 10000);

server.listen(PORT, '0.0.0.0');
