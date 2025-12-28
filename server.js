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
    'Bed': { color: 0x8b4513, cost: {}, breakTime: 2, buyAmount: 0, hasTexture: false }
};

const MAX_STACK = 64;
const INVENTORY_SIZE = 9;

// NEW: Island and bed management
const PLAYER_ISLANDS = new Map(); // playerId -> island position
const BEDS = new Map(); // islandKey -> {ownerId, position}
const MAX_RESOURCES_PER_SPAWNER = 64;
const SPAWNER_RESOURCES = new Map(); // spawnerIndex -> current count

// State
const blocks = new Map(); // `${x},${y},${z}` -> type
const pickups = new Map(); // id -> {x, y, z, resourceType}
const spawners = [];
const players = new Map(); // id -> {pos: {x,y,z}, rot: {yaw, pitch}, crouch: bool, inventory: array, currency: obj, selected: num}

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
    blocks.delete(key);
    io.emit('removeBlock', { x, y, z });
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

// NEW: Find available island for new player
function findAvailableIsland() {
    const islandPositions = [
        { x: -15, z: -15 },
        { x: 33, z: -15 },
        { x: -15, z: 33 },
        { x: 33, z: 33 },
        { x: 9, z: -15 },
        { x: 9, z: 33 },
        { x: 9, z: 9 }
    ];
    
    for (const pos of islandPositions) {
        const islandKey = `${pos.x},${pos.z}`;
        if (!BEDS.has(islandKey)) {
            return pos;
        }
    }
    return null; // No available islands
}

// MODIFIED: createIsland with bed support
function createIsland(offsetX, offsetZ, spawnerType = null, ownerId = null) {
    for (let x = 0; x < 6; x++) {
        for (let z = 0; z < 6; z++) {
            addBlock(offsetX + x, 0, offsetZ + z, 'Grass');
        }
    }
    
    // Add bed in center of island
    const bedX = offsetX + 2;
    const bedY = 1;
    const bedZ = offsetZ + 2;
    addBlock(bedX, bedY, bedZ, 'Bed');
    
    if (ownerId) {
        const islandKey = `${offsetX},${offsetZ}`;
        BEDS.set(islandKey, { ownerId, position: { x: bedX, y: bedY + 1, z: bedZ } });
        PLAYER_ISLANDS.set(ownerId, { x: offsetX, z: offsetZ });
    }
    
    if (spawnerType) {
        const s = { 
            x: offsetX + 2.5, 
            y: 1, 
            z: offsetZ + 2.5, 
            resourceType: spawnerType.type, 
            interval: spawnerType.interval * 1000, 
            lastSpawn: Date.now(),
            index: spawners.length
        };
        spawners.push(s);
        SPAWNER_RESOURCES.set(s.index, 0);
    }
}

// Init world (islands + spawners)
createIsland(-15, -15, { type: 'iron', interval: 3 });
createIsland(33, -15, { type: 'iron', interval: 3 });
createIsland(-15, 33, { type: 'iron', interval: 3 });
createIsland(33, 33, { type: 'iron', interval: 3 });
createIsland(9, -15, { type: 'gold', interval: 8 });
createIsland(9, 33, { type: 'gold', interval: 8 });
createIsland(9, 9, { type: 'emerald', interval: 10 });

// Socket connections
io.on('connection', (socket) => {
    console.log(`New connection: ${socket.id}`);
    
    // NEW: Island assignment logic
    const islandPos = findAvailableIsland();
    let spawnPos = { x: -12, y: 5, z: -12 }; // Default spawn
    
    if (islandPos) {
        // Check if player has a bed
        const existingIsland = Array.from(BEDS.entries()).find(([key, bed]) => bed.ownerId === socket.id);
        if (existingIsland) {
            spawnPos = existingIsland[1].position;
        } else {
            // Assign new island
            createIsland(islandPos.x, islandPos.z, null, socket.id);
            spawnPos = { x: islandPos.x + 2.5, y: 2, z: islandPos.z + 2.5 };
        }
    }
    
    const playerState = {
        pos: spawnPos,
        rot: { yaw: 0, pitch: 0 },
        crouch: false,
        inventory: new Array(INVENTORY_SIZE).fill(null),
        currency: { iron: 0, gold: 0, emerald: 0 },
        selected: 0
    };
    
    players.set(socket.id, playerState);
    
    // Send initial world
    const initBlocks = Array.from(blocks, ([key, type]) => {
        const [x, y, z] = key.split(',').map(Number);
        return { x, y, z, type };
    });
    const initPickups = Array.from(pickups, ([id, data]) => ({ id, ...data }));
    socket.emit('initWorld', { blocks: initBlocks, pickups: initPickups,
