const WebSocket = require('ws');
const http = require('http');
const url = require('url');

const PORT = process.env.PORT || 8080;

// Basic HTTP server to satisfy Railway's health checks
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('PRESENCE_SIGNALING_SERVER_ACTIVE');
});

const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
    try {
        const parameters = url.parse(req.url, true).query;
        const addressId = parameters.address;

        if (!addressId) {
            console.log("Connection rejected: No address provided.");
            return ws.terminate();
        }

        ws.locusAddress = addressId;
        ws.isAlive = true;

        // Perfect Negotiation Role Assignment
        const peers = Array.from(wss.clients).filter(c => 
            c !== ws && c.locusAddress === addressId && c.readyState === WebSocket.OPEN
        );

        if (peers.length === 0) {
            ws.role = 'polite';
        } else if (peers.length === 1) {
            ws.role = 'initiator';
            // Start the handshake
            ws.send(JSON.stringify({ type: 'ready', role: 'initiator' }));
            peers[0].send(JSON.stringify({ type: 'ready', role: 'polite' }));
        } else {
            ws.send(JSON.stringify({ type: 'error', message: 'ROOM_FULL' }));
            return ws.terminate();
        }

        ws.on('pong', () => { ws.isAlive = true; });

        ws.on('message', (rawData) => {
            try {
                const msg = JSON.parse(rawData);
                
                // Keep-alive heartbeat
                if (msg.type === 'ping') {
                    return ws.send(JSON.stringify({ type: 'pong' }));
                }

                // Relay messages to the other peer in the same "address"
                wss.clients.forEach(client => {
                    if (client.locusAddress === addressId && client !== ws && client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify(msg));
                    }
                });
            } catch (e) {
                console.error("Message handling error:", e);
            }
        });

        ws.on('close', () => {
            wss.clients.forEach(client => {
                if (client.locusAddress === addressId && client !== ws) {
                    client.send(JSON.stringify({ type: 'collapse', reason: 'peer_disconnected' }));
                }
            });
        });

    } catch (e) {
        console.error("Connection error:", e);
        ws.terminate();
    }
});

// The Reaper: Essential for mobile stability. 
// Kills ghost connections that Android might have dropped without a 'close' frame.
setInterval(() => {
    wss.clients.forEach((ws) => {
        if (!ws.isAlive) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
    });
}, 15000);

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Presence Signaling Server running on port ${PORT}`);
});
