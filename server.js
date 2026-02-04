const WebSocket = require('ws');
const http = require('http');
const url = require('url');

const PORT = process.env.PORT || 8080;

const server = http.createServer((req, res) => {
    if (req.url === '/healthz') {
        res.writeHead(200);
        return res.end('OK');
    }
    res.writeHead(200);
    res.end('PRESENCE_SIGNALING_v3_RUNNING');
});

const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
    const parameters = url.parse(req.url, true).query;
    const addressId = parameters.address;

    if (!addressId) {
        return ws.terminate();
    }

    ws.locusAddress = addressId;
    ws.isAlive = true;

    // 1. Identify Peers in the same room
    const peers = Array.from(wss.clients).filter(c => 
        c !== ws && c.locusAddress === addressId && c.readyState === WebSocket.OPEN
    );

    // 2. Role Assignment & Room Management
    if (peers.length === 0) {
        // First person in: Wait as polite peer
        ws.role = 'polite';
    } else if (peers.length === 1) {
        // Second person in: Become the initiator
        ws.role = 'initiator';
        
        // Signal BOTH to start their engines
        ws.send(JSON.stringify({ type: 'ready', role: 'initiator' }));
        peers[0].send(JSON.stringify({ type: 'ready', role: 'polite' }));
    } else {
        // Room full (Maximum 2 people)
        ws.send(JSON.stringify({ type: 'collapse', reason: 'ROOM_FULL' }));
        return ws.terminate();
    }

    // 3. Signal Relay Logic
    ws.on('message', (rawData) => {
        try {
            const msg = JSON.parse(rawData);
            
            // Heartbeat response
            if (msg.type === 'ping') {
                return ws.send(JSON.stringify({ type: 'pong' }));
            }

            // Broadcast to the other peer in the room
            wss.clients.forEach(client => {
                if (client !== ws && 
                    client.locusAddress === addressId && 
                    client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify(msg));
                }
            });
        } catch (e) {
            console.error("Relay Error:", e);
        }
    });

    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('close', () => {
        // Notify the remaining peer that the connection collapsed
        wss.clients.forEach(client => {
            if (client !== ws && client.locusAddress === addressId) {
                client.send(JSON.stringify({ type: 'collapse', reason: 'peer_lost' }));
            }
        });
    });
});

// Keep-alive loop to prevent Railway/Mobile timeouts
const interval = setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
    });
}, 10000);

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Presence Signaling Server running on port ${PORT}`);
});
