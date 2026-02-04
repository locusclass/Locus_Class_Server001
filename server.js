const WebSocket = require('ws');
const http = require('http');
const url = require('url');

// Configuration Constants
const PORT = process.env.PORT || 8080;
const PING_INTERVAL = 15000; // 15s to keep Android 9 radios high-power
const HEARTBEAT_TIMEOUT = 45000; // If no pong in 45s, kill connection

const server = http.createServer((req, res) => {
    // Health check for Railway/Cloud monitoring
    if (req.url === '/healthz') {
        res.writeHead(200);
        return res.end('OK');
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<body style="background:#000;color:#0f0;font-family:monospace;padding:20px;"><h1>PRESENCE_CORE // FULL_SIGNAL_RELAY // ACTIVE</h1></body>');
});

const wss = new WebSocket.Server({ server });

/**
 * ROOM MANAGEMENT:
 * We use the 'address' query param to group peers.
 */
wss.on('connection', (ws, req) => {
    try {
        const parameters = url.parse(req.url, true).query;
        const addressId = parameters.address;

        if (!addressId) {
            console.warn("Rejected connection: Missing addressId");
            return ws.terminate();
        }

        // Attach metadata to the socket object
        ws.locusAddress = addressId;
        ws.isAlive = true;
        ws.role = null;

        console.log(`Connection established for Room: ${addressId}`);

        // Setup Heartbeat
        ws.on('pong', () => { ws.isAlive = true; });

        // ROLE ASSIGNMENT & NEGOTIATION
        // Find existing peers in the same room
        const peers = Array.from(wss.clients).filter(c => 
            c !== ws && 
            c.locusAddress === addressId && 
            c.readyState === WebSocket.OPEN
        );

        if (peers.length === 0) {
            // First person in is 'polite' (waiting)
            ws.role = 'polite';
            console.log(`Room ${addressId}: First peer joined (Polite)`);
        } else if (peers.length === 1) {
            // Second person is 'initiator' (impolite/aggressive)
            ws.role = 'initiator';
            console.log(`Room ${addressId}: Second peer joined (Initiator)`);
            
            // Trigger the WebRTC handshake
            ws.send(JSON.stringify({ type: 'ready', role: 'initiator' }));
            peers[0].send(JSON.stringify({ type: 'ready', role: 'polite' }));
        } else {
            // Third person? Reject or handle as observer (Presence is 1-to-1)
            ws.send(JSON.stringify({ type: 'error', message: 'ROOM_FULL' }));
            return ws.terminate();
        }

        // MESSAGE ROUTING (The "Relay" Role)
        ws.on('message', (rawData) => {
            try {
                const msg = JSON.parse(rawData);

                // Handle system-level pings to save bandwidth
                if (msg.type === 'ping') {
                    return ws.send(JSON.stringify({ type: 'pong' }));
                }

                // LOGIC: Relay the message to everyone in the room EXCEPT the sender
                let deliveryCount = 0;
                wss.clients.forEach(client => {
                    if (
                        client.locusAddress === addressId && 
                        client !== ws && 
                        client.readyState === WebSocket.OPEN
                    ) {
                        client.send(JSON.stringify(msg));
                        deliveryCount++;
                    }
                });
            } catch (err) {
                console.error("JSON Parse Error on incoming relay");
            }
        });

        // CLEANUP ON DISCONNECT
        ws.on('close', () => {
            console.log(`Peer left Room: ${addressId}`);
            // Notify remaining peer that the connection collapsed
            wss.clients.forEach(client => {
                if (client.locusAddress === addressId && client !== ws) {
                    client.send(JSON.stringify({ type: 'collapse', reason: 'peer_disconnected' }));
                }
            });
        });

        ws.on('error', (err) => {
            console.error(`Socket Error: ${err.message}`);
            ws.terminate();
        });

    } catch (e) {
        console.error("Critical Connection Error:", e);
        ws.terminate();
    }
});

/**
 * THE REAPER:
 * Prevents "Ghost Connections" from hogging server RAM and Room slots.
 */
const interval = setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) {
            console.log("Terminating unresponsive ghost connection");
            return ws.terminate();
        }
        ws.isAlive = false;
        ws.ping(); // Standard WS ping
    });
}, PING_INTERVAL);

wss.on('close', () => clearInterval(interval));

server.listen(PORT, '0.0.0.0', () => {
    console.log(`
    -------------------------------------------
    PRESENCE CORE SERVER INITIALIZED
    Port: ${}
    Logic: WebRTC Perfect Negotiation Relay
    Mode: Android Version-Proof (Pie to 14)
    -------------------------------------------
    `);
});
