const WebSocket = require('ws');
const http = require('http');

const PORT = process.env.PORT || 8080;
const server = http.createServer();
const wss = new WebSocket.Server({ server });

const rooms = new Map();

wss.on('connection', (ws, req) => {
    const parameters = new URLSearchParams(req.url.split('?')[1]);
    const address = parameters.get('address');

    if (!address) {
        ws.close(1008, "Address required");
        return;
    }

    if (!rooms.has(address)) {
        rooms.set(address, new Set());
    }

    const room = rooms.get(address);

    if (room.size >= 2) {
        ws.send(JSON.stringify({ type: 'error', message: 'Room full' }));
        ws.close();
        return;
    }

    room.add(ws);
    console.log(`Peer joined room: ${address}. Total: ${room.size}`);

    // If there are 2 people, start the handshake
    if (room.size === 2) {
        const peers = Array.from(room);
        // roles: initiator (impolite) vs polite
        peers[0].send(JSON.stringify({ type: 'ready', role: 'initiator' }));
        peers[1].send(JSON.stringify({ type: 'ready', role: 'polite' })); 
    }

    ws.on('message', (data) => {
        const msgString = data.toString();
        
        // Heartbeat/Ping check to keep connection alive on Railway
        try {
            const parsed = JSON.parse(msgString);
            if (parsed.type === 'ping') return; 
        } catch(e) {}

        // Relay everything else (Offer/Answer/ICE/Text)
        room.forEach(client => {
            if (client !== ws && client.readyState === WebSocket.OPEN) {
                client.send(msgString);
            }
        });
    });

    ws.on('close', () => {
        room.delete(ws);
        if (room.size === 0) {
            rooms.delete(address);
        } else {
            room.forEach(client => {
                // Change 'collapse' to 'peer_obstructed' to give the Flutter 
                // engine a 10-second grace period to recover before a hard exit.
                client.send(JSON.stringify({ 
                    type: 'peer_obstructed', 
                    reason: 'link_lost',
                    seconds: 10 
                }));
            });
        }
        console.log(`Peer left room: ${address}`);
    });
});

server.listen(PORT, () => {
    console.log(`Signaling server running on port ${PORT}`);
});
