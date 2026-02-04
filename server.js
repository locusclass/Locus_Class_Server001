const WebSocket = require('ws');
const http = require('http');
const url = require('url');

const PORT = process.env.PORT || 8080;

const server = http.createServer((req, res) => {
    // Railway Health Check
    if (req.url === '/healthz') {
        res.writeHead(200);
        return res.end('OK');
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('PRESENCE_CORE_V3_ACTIVE');
});

const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
    try {
        const parameters = url.parse(req.url, true).query;
        const addressId = parameters.address;

        if (!addressId) return ws.terminate();

        ws.locusAddress = addressId;
        ws.isAlive = true;

        // Grouping peers for 1-to-1 WebRTC
        const peers = Array.from(wss.clients).filter(c => 
            c !== ws && c.locusAddress === addressId && c.readyState === WebSocket.OPEN
        );

        if (peers.length === 0) {
            // First peer is always "polite" by default until initiator arrives
            ws.role = 'polite';
        } else if (peers.length === 1) {
            // Second peer is the initiator
            ws.role = 'initiator';
            
            // Trigger handshake for both
            ws.send(JSON.stringify({ type: 'ready', role: 'initiator' }));
            peers[0].send(JSON.stringify({ type: 'ready', role: 'polite' }));
        } else {
            ws.send(JSON.stringify({ type: 'collapse', reason: 'ROOM_FULL' }));
            return ws.terminate();
        }

        ws.on('pong', () => { ws.isAlive = true; });

        ws.on('message', (rawData) => {
            try {
                const msg = JSON.parse(rawData);
                
                // Low-latency Heartbeat
                if (msg.type === 'ping') return ws.send(JSON.stringify({ type: 'pong' }));

                // Relay WebRTC/Text/Reveal signals to the peer
                wss.clients.forEach(client => {
                    if (client.locusAddress === addressId && client !== ws && client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify(msg));
                    }
                });
            } catch (e) { }
        });

        ws.on('close', () => {
            wss.clients.forEach(client => {
                if (client.locusAddress === addressId && client !== ws) {
                    client.send(JSON.stringify({ type: 'collapse', reason: 'peer_lost' }));
                }
            });
        });

    } catch (e) { 
        ws.terminate(); 
    }
});

// Vital for Android stability: Kills ghost sockets
setInterval(() => {
    wss.clients.forEach((ws) => {
        if (!ws.isAlive) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
    });
}, 10000);

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Presence Signaling Server running on port ${PORT}`);
});
