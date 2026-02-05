const WebSocket = require('ws');
const http = require('http');
const url = require('url');

const PORT = process.env.PORT || 8080;

// Room management for O(1) lookups
const rooms = new Map();

const server = http.createServer((req, res) => {
    if (req.url === '/healthz') {
        res.writeHead(200);
        return res.end('OK');
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('PRESENCE_CORE_V3_ACTIVE');
});

const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
    const parameters = url.parse(req.url, true).query;
    const addressId = parameters.address;

    if (!addressId) return ws.terminate();

    ws.locusAddress = addressId;
    ws.isAlive = true;

    // Initialize room if it doesn't exist
    if (!rooms.has(addressId)) {
        rooms.set(addressId, new Set());
    }
    
    const room = rooms.get(addressId);

    if (room.size >= 2) {
        ws.send(JSON.stringify({ type: 'collapse', reason: 'ROOM_FULL' }));
        return ws.terminate();
    }

    room.add(ws);

    // Determine roles: First is polite, second is initiator
    if (room.size === 1) {
        ws.role = 'polite';
    } else {
        ws.role = 'initiator';
        // Notify both peers to start the handshake simultaneously
        const peerList = Array.from(room);
        peerList.forEach(client => {
            client.send(JSON.stringify({ 
                type: 'ready', 
                role: client.role 
            }));
        });
    }

    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (rawData) => {
        try {
            const msg = JSON.parse(rawData);
            
            // Internal Heartbeat
            if (msg.type === 'ping') {
                return ws.send(JSON.stringify({ type: 'pong' }));
            }

            // Target relay: Only send to the OTHER person in this specific room
            room.forEach(client => {
                if (client !== ws && client.readyState === WebSocket.OPEN) {
                    client.send(rawData); // Send raw buffer for speed
                }
            });
        } catch (e) {
            console.error("Relay error:", e);
        }
    });

    ws.on('close', () => {
        room.delete(ws);
        // Notify the remaining peer
        room.forEach(client => {
            client.send(JSON.stringify({ type: 'collapse', reason: 'peer_lost' }));
        });
        // Clean up empty rooms
        if (room.size === 0) {
            rooms.delete(addressId);
        }
    });

    ws.on('error', () => ws.terminate());
});

// Clean up dead connections every 30 seconds (reduced frequency to save server CPU)
const interval = setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);

wss.on('close', () => clearInterval(interval));

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Presence Signaling Server running on port ${PORT}`);
});
