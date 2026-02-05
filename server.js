const WebSocket = require('ws');
const http = require('http');

// Use the port Railway provides, or 8080 locally
const PORT = process.env.PORT || 8080;
const server = http.createServer();
const wss = new WebSocket.Server({ server });

// Room storage: address -> Set of client sockets
const rooms = new Map();

wss.on('connection', (ws, req) => {
    // Extract address from URL query: ws://url?address=123
    const parameters = new URLSearchParams(req.url.split('?')[1]);
    const address = parameters.get('address');

    if (!address) {
        ws.close(1008, "Address required");
        return;
    }

    // Initialize room if it doesn't exist
    if (!rooms.has(address)) {
        rooms.set(address, new Set());
    }

    const room = rooms.get(address);

    // Limit to 2 people per room for WebRTC P2P
    if (room.size >= 2) {
        ws.send(JSON.stringify({ type: 'error', message: 'Room full' }));
        ws.close();
        return;
    }

    room.add(ws);
    console.log(`Peer joined room: ${address}. Total: ${room.size}`);

    // If there are now 2 people, tell them to start WebRTC
    if (room.size === 2) {
        const peers = Array.from(room);
        // Randomly assign one as the initiator
        peers[0].send(JSON.stringify({ type: 'ready', role: 'initiator' }));
        peers[1].send(JSON.stringify({ type: 'ready', role: 'receiver' }));
    }

    ws.on('message', (data) => {
        // Relay message to the other person in the room
        const message = data.toString();
        room.forEach(client => {
            if (client !== ws && client.readyState === WebSocket.OPEN) {
                client.send(message);
            }
        });
    });

    ws.on('close', () => {
        room.delete(ws);
        if (room.size === 0) {
            rooms.delete(address);
        } else {
            // Tell remaining peer the other left
            room.forEach(client => {
                client.send(JSON.stringify({ type: 'collapse', reason: 'peer_disconnected' }));
            });
        }
        console.log(`Peer left room: ${address}`);
    });
});

server.listen(PORT, () => {
    console.log(`Signaling server running on port ${PORT}`);
});
