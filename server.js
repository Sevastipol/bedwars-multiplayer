// server.js
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => console.log(`Server on port ${PORT}`));

// Config (copied from client)
const BLOCK_TYPES = {
    'Grass': { color: 0x4d9043, cost: { iron: 5 }, breakTime: 1.2, buyAmount: 8, hasTexture: true },
    'Glass': { color: 0xade8f4, cost: { iron: 5 }, breakTime: 0.4, buyAmount: 16, opacity: 0.6 },
    'Wood': { color: 0x5d4037, cost: { gold: 5 }, breakTime: 3, buyAmount: 32, hasTexture: true },
    'Stone': { color: 0x777777, cost: { gold: 5 }, breakTime: 6, buyAmount: 8, hasTexture: true },
    'Obsidian': { color: 0x111111, cost: { emerald: 1 }, breakTime: 12, buyAmount: 1, hasTexture: true },
    'Bed': { color: 0xff0000, breakTime: 2, buyAmount: 1, hasTexture: false }
};
const MAX_STACK = 64;
const INVENTORY_SIZE = 9;
const ROUND_DURATION = 15 * 60 * 1000; // 15 minutes
const SUDDEN_DEATH_TIME = 10 * 60 * 1000; // 10 minutes
const SPECTATOR_SPAWN = { x: 9 + 2.5, y: 20, z: 9 + 2.5 };

// State
const blocks = new Map(); // `${x},${y},${z}` -> type
const pickups = new Map(); // id -> {x, y, z, resourceType}
const spawners = [];
const players = new Map(); // id -> {pos: {x,y,z}, rot: {yaw, pitch}, crouch: bool, inventory: array, currency: obj, selected: num, bedPos: {x,y,z}|null, lastRespawn: num, isSpectator: bool}
let gameState = 'waiting';
let countdownTimer = null;
let roundStartTime = null;
let roundEndTime = null;
let suddenDeath = false;

function blockKey(x, y, z) {
    return `${x},${y},${z}`;
}

function addBlock(x, y, z, type) {
    const key = blockKey(x, y, z);
    if (blocks.has(key)) return false;
    blocks.set(key, type);
    io.emit('addBlock', { x, y, z, type });
    return true;
}

function removeBlock(x, y, z) {
    const key = blockKey(x, y, z);
    if (!blocks.has(key)) return false;
    const type = blocks.get(key);
    blocks.delete(key);
    io.emit('removeBlock', { x, y, z });
    
    if (type === 'Bed') {
        players.forEach((p, id) => {
            if (p.bedPos && p.bedPos.x === x && p.bedPos.y === y && p.bedPos.z === z) {
                p.bedPos = null;
                io.to(id).emit('bedDestroyed');
            }
        });
    }
    return true;
}

function spawnPickup(x, y, z, resourceType) {
    const id = `${Date.now()}-${Math.random().toString(36).substring(7)}`;
    pickups.set(id, { x, y, z, resourceType });
    io.emit('addPickup', { id, x, y, z, resourceType });
}

function addToInventory(inv, type, amount) {
    let remaining = amount;
    // Fill existing stacks
    for (let i = 0; i < INVENTORY_SIZE; i++) {
        if (inv[i] && inv[i].type === type && inv[i].count < MAX_STACK) {
            const space = MAX_STACK - inv[i].count;
            const add = Math.min(space, remaining);
            inv[i].count += add;
            remaining -= add;
            if (remaining === 0) return true;
        }
    }
    // New stacks
    for (let i = 0; i < INVENTORY_SIZE; i++) {
        if (!inv[i]) {
            const add = Math.min(MAX_STACK, remaining);
            inv[i] = { type, count: add };
            remaining -= add;
            if (remaining === 0) return true;
        }
    }
    return remaining === 0;
}

function canAfford(currency, cost) {
    for (const [res, amt] of Object.entries(cost)) {
        if ((currency[res] || 0) < amt) return false;
    }
    return true;
}

function deductCurrency(currency, cost) {
    for (const [res, amt] of Object.entries(cost)) {
        currency[res] -= amt;
    }
}

// Init world (islands + spawners)
function createIsland(offsetX, offsetZ, spawnerType = null) {
    for (let x = 0; x < 6; x++) {
        for (let z = 0; z < 6; z++) {
            addBlock(offsetX + x, 0, offsetZ + z, 'Grass');
        }
    }
    if (spawnerType) {
        const s = {
            x: offsetX + 2.5, y: 1, z: offsetZ + 2.5,
            resourceType: spawnerType.type,
            interval: spawnerType.interval * 1000,
            lastSpawn: Date.now()
        };
        spawners.push(s);
    }
}

const playerIslands = [
    {offsetX: -15, offsetZ: -15, bedX: -14, bedY: 1, bedZ: -14},
    {offsetX: 33, offsetZ: -15, bedX: 34, bedY: 1, bedZ: -14},
    {offsetX: -15, offsetZ: 33, bedX: -14, bedY: 1, bedZ: 34},
    {offsetX: 33, offsetZ: 33, bedX: 34, bedY: 1, bedZ: 34}
];

function initWorld() {
    blocks.clear();
    pickups.clear();
    spawners.length = 0;
    // Create all islands with spawners
    createIsland(-15, -15, { type: 'iron', interval: 3 });
    createIsland(33, -15, { type: 'iron', interval: 3 });
    createIsland(-15, 33, { type: 'iron', interval: 3 });
    createIsland(33, 33, { type: 'iron', interval: 3 });
    createIsland(9, -15, { type: 'gold', interval: 8 });
    createIsland(9, 33, { type: 'gold', interval: 8 });
    createIsland(9, 9, { type: 'emerald', interval: 10 });
}

initWorld();

function startRound() {
    gameState = 'playing';
    roundStartTime = Date.now();
    roundEndTime = roundStartTime + ROUND_DURATION;
    suddenDeath = false;
    
    // Create all beds for active players (non-spectators)
    players.forEach((p, id) => {
        if (!p.isSpectator && p.bedPos) {
            addBlock(p.bedPos.x, p.bedPos.y, p.bedPos.z, 'Bed');
        }
    });
    
    io.emit('gameStart', { roundEndTime });
}

function resetGame() {
    initWorld();
    const initBlocks = Array.from(blocks, ([key, type]) => {
        const [x, y, z] = key.split(',').map(Number);
        return { x, y, z, type };
    });
    const initPickups = Array.from(pickups, ([id, data]) => ({ id, ...data }));
    
    // Reset all players to spectators
    players.forEach((p, id) => {
        p.inventory = new Array(INVENTORY_SIZE).fill(null);
        p.currency = { iron: 0, gold: 0, emerald: 0 };
        p.selected = 0;
        p.rot = { yaw: 0, pitch: 0 };
        p.crouch = false;
        p.lastRespawn = 0;
        p.bedPos = null;
        p.isSpectator = true;
        p.pos = SPECTATOR_SPAWN;
        
        io.to(id).emit('playerReset', {
            pos: p.pos,
            rot: p.rot,
            inventory: p.inventory,
            currency: p.currency,
            isSpectator: p.isSpectator
        });
    });
    
    io.emit('worldReset', { blocks: initBlocks, pickups: initPickups, spawners });
    gameState = 'waiting';
    roundStartTime = null;
    roundEndTime = null;
}

// Socket connections
io.on('connection', (socket) => {
    console.log(`New connection: ${socket.id}`);
    const playerState = {
        pos: SPECTATOR_SPAWN,
        rot: { yaw: 0, pitch: 0 },
        crouch: false,
        inventory: new Array(INVENTORY_SIZE).fill(null),
        currency: { iron: 0, gold: 0, emerald: 0 },
        selected: 0,
        bedPos: null,
        lastRespawn: 0,
        isSpectator: true
    };
    
    players.set(socket.id, playerState);

    // Send initial world
    const initBlocks = Array.from(blocks, ([key, type]) => {
        const [x, y, z] = key.split(',').map(Number);
        return { x, y, z, type };
    });
    const initPickups = Array.from(pickups, ([id, data]) => ({ id, ...data }));
    socket.emit('initWorld', { 
        blocks: initBlocks, 
        pickups: initPickups, 
        spawners,
        gameState,
        timeLeft: gameState === 'playing' ? (roundEndTime - Date.now()) : null
    });

    // Send your ID
    socket.emit('yourId', socket.id);

    // Send other players (excluding spectators)
    const otherPlayers = Array.from(players.entries())
        .filter(([id, p]) => id !== socket.id && !p.isSpectator)
        .map(([id, p]) => ({ id, pos: p.pos, rot: p.rot, crouch: p.crouch }));
    socket.emit('playersSnapshot', otherPlayers);

    // Update waiting for players message
    const activePlayers = Array.from(players.values()).filter(p => !p.isSpectator).length;
    const playersNeeded = Math.max(0, 2 - activePlayers);
    io.emit('waitingForPlayers', playersNeeded);

    socket.on('playerUpdate', (data) => {
        const p = players.get(socket.id);
        if (p && !p.isSpectator) {
            p.pos = data.pos;
            p.rot = data.rot;
            p.crouch = data.crouch;
            p.selected = data.selected;
        }
    });

    socket.on('claimPickupAttempt', (id) => {
        if (!pickups.has(id)) return;
        const p = players.get(socket.id);
        if (p.isSpectator) return;
        const pickup = pickups.get(id);
        const dist = Math.hypot(p.pos.x - pickup.x, p.pos.y - pickup.y, p.pos.z - pickup.z);
        if (dist >= 1.5) {
            socket.emit('revertPickup', { id, x: pickup.x, y: pickup.y, z: pickup.z, resourceType: pickup.resourceType });
            return;
        }
        const res = pickup.resourceType;
        p.currency[res]++;
        pickups.delete(id);
        io.emit('removePickup', id);
        socket.emit('updateCurrency', { ...p.currency });
    });

    socket.on('breakAttempt', ({ x, y, z }) => {
        const p = players.get(socket.id);
        if (p.isSpectator) return;
        const key = blockKey(x, y, z);
        if (!blocks.has(key)) {
            socket.emit('revertBreak', { x, y, z, type: null });
            return;
        }
        const dist = Math.hypot(
            p.pos.x - (x + 0.5),
            (p.pos.y - (p.crouch ? 1.3 : 1.6)) - (y + 0.5),
            p.pos.z - (z + 0.5)
        );
        if (dist > 5) {
            socket.emit('revertBreak', { x, y, z, type: blocks.get(key) });
            return;
        }
        const type = blocks.get(key);
        if (type === 'Bed') {
            // Check if this is the player's own bed
            if (p.bedPos && p.bedPos.x === x && p.bedPos.y === y && p.bedPos.z === z) {
                socket.emit('revertBreak', { x, y, z, type });
                return;
            }
        }
        if (addToInventory(p.inventory, type, 1)) {
            removeBlock(x, y, z);
            socket.emit('updateInventory', p.inventory.map(slot => slot ? { ...slot } : null));
        } else {
            socket.emit('revertBreak', { x, y, z, type });
        }
    });

    socket.on('placeAttempt', ({ x, y, z, type }) => {
        const p = players.get(socket.id);
        if (p.isSpectator) return;
        const key = blockKey(x, y, z);
        if (blocks.has(key)) {
            socket.emit('revertPlace', { x, y, z });
            return;
        }
        const slot = p.inventory[p.selected];
        if (!slot || slot.type !== type || slot.count < 1) {
            socket.emit('revertPlace', { x, y, z });
            return;
        }
        const dist = Math.hypot(
            p.pos.x - (x + 0.5),
            (p.pos.y - (p.crouch ? 1.3 : 1.6)) - (y + 0.5),
            p.pos.z - (z + 0.5)
        );
        if (dist > 5) {
            socket.emit('revertPlace', { x, y, z });
            return;
        }
        slot.count--;
        if (slot.count === 0) p.inventory[p.selected] = null;
        addBlock(x, y, z, type);
        socket.emit('updateInventory', p.inventory.map(slot => slot ? { ...slot } : null));
    });

    socket.on('buyAttempt', (btype) => {
        const p = players.get(socket.id);
        if (p.isSpectator) return;
        if (btype === 'Bed') {
            socket.emit('buyFailed');
            return;
        }
        const data = BLOCK_TYPES[btype];
        if (!data) {
            socket.emit('buyFailed');
            return;
        }
        if (!canAfford(p.currency, data.cost)) {
            socket.emit('buyFailed');
            return;
        }
        if (!addToInventory(p.inventory, btype, data.buyAmount)) {
            socket.emit('buyFailed');
            return;
        }
        deductCurrency(p.currency, data.cost);
        socket.emit('updateCurrency', { ...p.currency });
        socket.emit('updateInventory', p.inventory.map(slot => slot ? { ...slot } : null));
    });

    socket.on('disconnect', () => {
        console.log(`Disconnected: ${socket.id}`);
        const p = players.get(socket.id);
        if (p && !p.isSpectator) {
            io.emit('removePlayer', socket.id);
        }
        players.delete(socket.id);
        
        // Update waiting for players message if in waiting state
        if (gameState === 'waiting') {
            const activePlayers = Array.from(players.values()).filter(p => !p.isSpectator).length;
            const playersNeeded = Math.max(0, 2 - activePlayers);
            io.emit('waitingForPlayers', playersNeeded);
        }
    });
});

// Game loop (spawns + player sync)
setInterval(() => {
    const now = Date.now();
    
    // Only run spawners if the game is playing
    if (gameState === 'playing') {
        spawners.forEach((s) => {
            if (now - s.lastSpawn >= s.interval) {
                spawnPickup(s.x, s.y + 0.8, s.z, s.resourceType);
                s.lastSpawn = now;
            }
        });

        // Send time update to all clients
        const timeLeft = roundEndTime - now;
        io.emit('timeUpdate', timeLeft);

        const elapsed = now - roundStartTime;
        
        // Sudden death after 10 minutes (destroy all beds)
        if (!suddenDeath && elapsed >= SUDDEN_DEATH_TIME) {
            Array.from(blocks.entries()).filter(([_, type]) => type === 'Bed').forEach(([key]) => {
                const [x, y, z] = key.split(',').map(Number);
                removeBlock(x, y, z);
            });
            io.emit('notification', 'Beds destroyed - SUDDEN DEATH');
            suddenDeath = true;
        }

        // Check for death/respawn
        players.forEach((p, id) => {
            if (!p.isSpectator && p.pos.y < -30 && now - p.lastRespawn > 2000) {
                if (p.bedPos && blocks.get(blockKey(p.bedPos.x, p.bedPos.y, p.bedPos.z)) === 'Bed') {
                    p.pos.x = p.bedPos.x + 0.5;
                    p.pos.y = p.bedPos.y + 2;
                    p.pos.z = p.bedPos.z + 0.5;
                    p.rot.yaw = 0;
                    p.rot.pitch = 0;
                    io.to(id).emit('respawn', { pos: p.pos, rot: p.rot });
                } else {
                    // Eliminated: become spectator
                    p.isSpectator = true;
                    p.pos = SPECTATOR_SPAWN;
                    io.to(id).emit('becomeSpectator', { pos: p.pos });
                    io.emit('removePlayer', id);
                    io.to(id).emit('notification', 'Eliminated! You are now a spectator.');
                }
                p.lastRespawn = now;
            }
        });

        // Check if only one player is left (non-spectator)
        const activePlayers = Array.from(players.values()).filter(p => !p.isSpectator);
        if (activePlayers.length === 1) {
            const winnerId = Array.from(players.entries()).find(([id, p]) => !p.isSpectator)[0];
            io.emit('gameEnd', { winner: winnerId });
            setTimeout(resetGame, 5000);
            return;
        } else if (activePlayers.length === 0) {
            // No active players left
            io.emit('gameEnd', { winner: null });
            setTimeout(resetGame, 5000);
            return;
        }

        // Check if the round is over (time's up)
        if (now >= roundEndTime) {
            // Find the winner (non-spectator players)
            const nonSpectatorPlayers = Array.from(players.entries()).filter(([id, p]) => !p.isSpectator);
            if (nonSpectatorPlayers.length === 1) {
                const winnerId = nonSpectatorPlayers[0][0];
                io.emit('gameEnd', { winner: winnerId });
            } else {
                io.emit('gameEnd', { winner: null });
            }
            setTimeout(resetGame, 5000);
        }
    }

    // Sync players (only non-spectators)
    const states = Array.from(players.entries())
        .filter(([id, p]) => !p.isSpectator)
        .map(([id, p]) => {
            return { id, pos: p.pos, rot: p.rot, crouch: p.crouch };
        });
    io.emit('playersUpdate', states);
}, 50);

// Start countdown when enough players join
function checkStartCountdown() {
    const activePlayers = Array.from(players.values()).filter(p => !p.isSpectator).length;
    
    if (gameState === 'waiting' && activePlayers >= 2) {
        // Assign islands to all active players
        let availableIslands = [...playerIslands];
        players.forEach((p, id) => {
            if (!p.isSpectator && availableIslands.length > 0) {
                const island = availableIslands.shift();
                p.bedPos = { x: island.bedX, y: island.bedY, z: island.bedZ };
                p.pos = { x: island.bedX + 0.5, y: island.bedY + 2, z: island.bedZ + 0.5 };
                io.to(id).emit('assignIsland', { 
                    pos: p.pos,
                    bedPos: p.bedPos 
                });
            }
        });
        
        // Start 10 second countdown
        let count = 10;
        io.emit('notification', 'Game starting in 10 seconds!');
        countdownTimer = setInterval(() => {
            io.emit('countdown', count);
            count--;
            if (count < 0) {
                clearInterval(countdownTimer);
                startRound();
            }
        }, 1000);
    }
}

// Listen for player ready to join game
io.on('connection', (socket) => {
    // ... existing connection code ...
    
    socket.on('joinGame', () => {
        const p = players.get(socket.id);
        if (p && p.isSpectator) {
            p.isSpectator = false;
            io.emit('removePlayer', socket.id); // Remove as spectator model
            socket.emit('joinGameSuccess');
            
            // Update waiting message
            const activePlayers = Array.from(players.values()).filter(p => !p.isSpectator).length;
            const playersNeeded = Math.max(0, 2 - activePlayers);
            io.emit('waitingForPlayers', playersNeeded);
            
            // Check if we can start countdown
            checkStartCountdown();
        }
    });
    
    socket.on('leaveGame', () => {
        const p = players.get(socket.id);
        if (p && !p.isSpectator) {
            p.isSpectator = true;
            p.pos = SPECTATOR_SPAWN;
            p.bedPos = null;
            io.emit('removePlayer', socket.id);
            socket.emit('becomeSpectator', { pos: p.pos });
            
            // Update waiting message
            const activePlayers = Array.from(players.values()).filter(p => !p.isSpectator).length;
            const playersNeeded = Math.max(0, 2 - activePlayers);
            io.emit('waitingForPlayers', playersNeeded);
        }
    });
});
