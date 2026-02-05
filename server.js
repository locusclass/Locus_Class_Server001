const WebSocket = require('ws');
const http = require('http');
const url = require('url');

const PORT = process.env.PORT || 8080;

/**
 * Room management: Map<addressId, Set<WebSocket>>
 * Provides O(1) lookup for peer discovery.
 */
const rooms = new Map();

/**
 * HTTP Server for Health Checks
 */
const server = http.createServer((req, res) => {
    if (req.url === '/healthz' || req.url === '/health') {
        res.writeHead(200);
        return res.end('OK');
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('PRESENCE_SIGNAL_BRIDGE_V3_ACTIVE');
});

const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
    const parameters = url.parse(req.url, true).query;
    const addressId = parameters.address;

    // Safety: Close connection if no address provided
    if (!addressId) {
        console.log("Rejected: No Address ID");
        return ws.terminate();
    }

    ws.locusAddress = addressId;
    ws.isAlive = true;

    // Initialize room if first arrival
    if (!rooms.has(addressId)) {
        rooms.set(addressId, new Set());
    }
    
    const room = rooms.get(addressId);

    // Limit: Max 2 peers per address
    if (room.size >= 2) {
        ws.send(JSON.stringify({ type: 'collapse', reason: 'ROOM_FULL' }));
        return ws.terminate();
    }

    room.add(ws);
    console.log(`Peer joined [${addressId}]. Room size: ${room.size}`);

    /**
     * ROLE ASSIGNMENT:
     * First peer to join is the 'polite' peer (Receiver).
     * Second peer to join is the 'initiator' (Caller).
     */
    if (room.size === 1) {
        ws.role = 'polite';
    } else {
        ws.role = 'initiator';

        // Notify both peers to start handshaking
        // Initiator will wait 200ms (client-side) before sending offer
        room.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify({ 
                    type: 'ready', 
                    role: client.role 
                }));
            }
        });
    }

    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (rawData) => {
        try {
            // Check for heartbeat/ping
            const dataStr = rawData.toString();
            if (dataStr.includes('"type":"ping"')) {
                return ws.send(JSON.stringify({ type: 'pong' }));
            }

            // RELAY: Send message to the other person in the room
            room.forEach(client => {
                if (client !== ws && client.readyState === WebSocket.OPEN) {
                    client.send(rawData); 
                }
            });
        } catch (e) {
            console.error("Relay error:", e);
        }
    });

    ws.on('close', () => {
        room.delete(ws);
        console.log(`Peer left [${addressId}]. Remaining: ${room.size}`);

        // Notify remaining peer to collapse the UI
        room.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify({ type: 'collapse', reason: 'peer_lost' }));
            }
        });

        // Clean up memory if room is empty
        if (room.size === 0) {
            rooms.delete(addressId);
        }
    });

    ws.on('error', (err) => {
        console.error("WS Error:", err);
        ws.terminate();
    });
});

/**
 * GHOST PREVENTION:
 * Clean up dead connections every 30 seconds to prevent "Room Full" errors.
 */
const interval = setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) {
            console.log("Terminating ghost connection");
            return ws.terminate();
        }
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);

wss.on('close', () => clearInterval(interval));

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Presence Signaling Server running on port ${PORT}`);
});
