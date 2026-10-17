/**
 * JavaGoat WhatsApp Bot
 * - Firebase access is authenticated (bot has its own Firebase Auth user)
 * - WhatsApp session is stored in Firebase (no QR re-scan on every GitHub Actions run)
 * - Multi-item orders, confirm/cancel, status command, location pin
 * - Auto status updates to customers + new-order alerts to admin on WhatsApp
 *
 * Required env vars (GitHub Secrets):
 *   FIREBASE_URL      e.g. https://YOUR_PROJECT-default-rtdb.firebaseio.com
 *   FIREBASE_API_KEY  Firebase web API key
 *   BOT_EMAIL         email of the bot's Firebase Auth user
 *   BOT_PASSWORD      password of that user
 */

const FIREBASE_URL = (process.env.FIREBASE_URL || '').replace(/\/+$/, '');
const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY || '';
const BOT_EMAIL = process.env.BOT_EMAIL || '';
const BOT_PASSWORD = process.env.BOT_PASSWORD || '';

const STATE_TTL_MS = 30 * 60 * 1000;      // unfinished order draft expires after 30 min
const POLL_EVERY_MS = 20 * 1000;          // order status / admin alert polling
const POLL_WINDOW_MS = 12 * 60 * 60 * 1000;
const ADMIN_ALERT_MAX_AGE_MS = 30 * 60 * 1000;
const MAX_QTY = 20;

// ======================= Firebase REST (authenticated) =======================
const tokenCache = { idToken: null, refreshToken: null, exp: 0, pending: null };

async function fetchToken() {
    if (!FIREBASE_API_KEY || !BOT_EMAIL || !BOT_PASSWORD) {
        throw new Error('Missing FIREBASE_API_KEY / BOT_EMAIL / BOT_PASSWORD env vars');
    }
    if (tokenCache.refreshToken) {
        try {
            const r = await fetch(`https://securetoken.googleapis.com/v1/token?key=${FIREBASE_API_KEY}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(tokenCache.refreshToken)}`,
            });
            const j = await r.json();
            if (r.ok && j.id_token) {
                tokenCache.idToken = j.id_token;
                tokenCache.refreshToken = j.refresh_token || tokenCache.refreshToken;
                tokenCache.exp = Date.now() + Number(j.expires_in || 3600) * 1000;
                return;
            }
        } catch (_) { /* fall through to password sign-in */ }
    }
    const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: BOT_EMAIL, password: BOT_PASSWORD, returnSecureToken: true }),
    });
    const j = await r.json();
    if (!r.ok || !j.idToken) throw new Error('Firebase bot login failed: ' + JSON.stringify(j.error || j));
    tokenCache.idToken = j.idToken;
    tokenCache.refreshToken = j.refreshToken;
    tokenCache.exp = Date.now() + Number(j.expiresIn || 3600) * 1000;
}

async function getToken() {
    if (tokenCache.idToken && Date.now() < tokenCache.exp - 60 * 1000) return tokenCache.idToken;
    if (!tokenCache.pending) {
        tokenCache.pending = fetchToken().finally(() => { tokenCache.pending = null; });
    }
    await tokenCache.pending;
    return tokenCache.idToken;
}

// query: object like { orderBy: 'userId', equalTo: 'whatsapp_123' }
async function fb(method, path, body, query) {
    const token = await getToken();
    let url = `${FIREBASE_URL}/${path}.json?auth=${encodeURIComponent(token)}`;
    if (query) {
        for (const [k, v] of Object.entries(query)) {
            const val = (k === 'limitToLast' || k === 'limitToFirst') ? String(v) : JSON.stringify(v);
            url += `&${k}=${encodeURIComponent(val)}`;
        }
    }
    const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Firebase ${method} ${path} -> ${res.status} ${await res.text()}`);
    return res.json();
}
const fbGet = (p, q) => fb('GET', p, undefined, q);
const fbPut = (p, b) => fb('PUT', p, b);
const fbPatch = (p, b) => fb('PATCH', p, b);
const fbPost = (p, b) => fb('POST', p, b);
const fbDelete = (p) => fb('DELETE', p);

// ======================= WhatsApp session stored in Firebase =======================
async function useFirebaseAuthState() {
    const { initAuthCreds, BufferJSON, proto } = require('@whiskeysockets/baileys');
    const enc = (s) => String(s).replace(/\//g, '__').replace(/:/g, '-').replace(/\./g, '_');
    const read = async (key) => {
        const v = await fbGet(`botSession/${enc(key)}`);
        return v ? JSON.parse(v, BufferJSON.reviver) : null;
    };
    const write = (key, data) => fbPut(`botSession/${enc(key)}`, JSON.stringify(data, BufferJSON.replacer));
    const remove = (key) => fbDelete(`botSession/${enc(key)}`);

    const creds = (await read('creds')) || initAuthCreds();
    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(ids.map(async (id) => {
                        let value = await read(`${type}-${id}`);
                        if (type === 'app-state-sync-key' && value) {
                            value = proto.Message.AppStateSyncKeyData.fromObject(value);
                        }
                        data[id] = value;
                    }));
                    return data;
                },
                set: async (data) => {
                    const tasks = [];
                    for (const category of Object.keys(data)) {
                        for (const id of Object.keys(data[category])) {
                            const value = data[category][id];
                            tasks.push(value ? write(`${category}-${id}`, value) : remove(`${category}-${id}`));
                        }
                    }
                    await Promise.all(tasks);
                },
            },
        },
        saveCreds: () => write('creds', creds),
    };
}

// ======================= Settings (managed from Admin panel) =======================
let settingsCache = { at: 0, value: null };
async function getSettings() {
    if (settingsCache.value && Date.now() - settingsCache.at < 60 * 1000) return settingsCache.value;
    let s = {};
    try { s = (await fbGet('settings')) || {}; } catch (e) { console.log('settings read failed:', e.message); }
    const fee = parseFloat(s.deliveryFee);
    settingsCache = {
        at: Date.now(),
        value: {
            isOpen: s.isOpen !== false,
            deliveryFee: (!isNaN(fee) && fee >= 0) ? fee : 50,
            adminWhatsApp: String(s.adminWhatsApp || '').split(',').map(n => n.replace(/\D/g, '')).filter(Boolean),
            closedMessage: s.closedMessage || 'We are closed right now. Please try again later. 🙏',
        },
    };
    return settingsCache.value;
}

// ======================= Helpers =======================
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9\u0600-\u06ff\s]/g, ' ').replace(/\s+/g, ' ').trim();
const tokens = (s) => norm(s).split(' ').filter(Boolean);
const money = (n) => `₹${(Math.round(n * 100) / 100).toFixed(2).replace(/\.00$/, '')}`;
const shortId = (key) => '#' + key.substring(1, 7).toUpperCase();
const stateKey = (jid) => jid.replace(/[.#$\[\]\/@]/g, '_');
const YES = new Set(['yes', 'y', 'ok', 'okay', 'confirm', 'haan', 'han', 'ji', 'jee', 'theek', 'done']);
const NO = new Set(['no', 'n', 'cancel', 'nahi', 'nahin', 'nai', 'na', 'stop']);
const GREETINGS = new Set(['hi', 'hello', 'hey', 'hii', 'hy', 'salam', 'salaam', 'assalam', 'assalamualaikum', 'aoa', 'slam', 'start']);

async function getMenu() {
    const data = (await fbGet('dishes')) || {};
    return Object.entries(data)
        .map(([id, d]) => ({ id, name: String(d.name || ''), price: parseFloat(d.price), imageUrl: d.imageUrl || '' }))
        .filter(d => d.name && !isNaN(d.price));
}

function menuText(menu, fee) {
    if (!menu.length) return 'Menu is empty right now. Please check back soon!';
    let t = '🍽️ *JavaGoat Menu*\n\n';
    menu.forEach(i => { t += `• ${i.name} — ${money(i.price)}\n`; });
    t += `\n🛵 Delivery: ${money(fee)}\n`;
    t += '\nTo order, type like this:\n*order 2 pizza, 1 burger*';
    return t;
}

// Parse "order 2 pizza, 1 burger x2" against the menu.
function parseOrderText(raw, menu) {
    const parts = String(raw).split(/,|\n|\+|\band\b/i).map(p => p.trim()).filter(Boolean);
    const found = new Map();
    const problems = [];

    const matchName = (name) => {
        const n = norm(name);
        if (!n) return { none: true };
        const exact = menu.filter(m => norm(m.name) === n);
        if (exact.length === 1) return { item: exact[0] };
        const inc = menu.filter(m => norm(m.name).includes(n));
        if (inc.length === 1) return { item: inc[0] };
        if (inc.length > 1) return { many: inc };
        return { none: true };
    };

    for (const part of parts) {
        let qty = 1;
        let name = part;
        let res = matchName(part);               // whole part might be a dish name like "7 up"
        if (res.none) {
            let m = part.match(/^(\d{1,3})\s*(?:x|×|pcs?|pieces?)?\s+(.+)$/i);
            if (m) { qty = parseInt(m[1], 10); name = m[2]; }
            else if ((m = part.match(/^(.+?)\s*(?:x|×)\s*(\d{1,3})$/i)) || (m = part.match(/^(.+?)\s+(\d{1,3})$/))) {
                name = m[1]; qty = parseInt(m[2], 10);
            }
            res = matchName(name);
        }
        if (res.many) { problems.push(`"${name.trim()}" matches more than one item: ${res.many.map(i => i.name).join(', ')}`); continue; }
        if (res.none) { problems.push(`"${name.trim()}" is not on the menu`); continue; }
        if (qty < 1 || qty > MAX_QTY) { problems.push(`Quantity for ${res.item.name} must be 1-${MAX_QTY}`); continue; }
        const prev = found.get(res.item.id);
        const total = (prev ? prev.quantity : 0) + qty;
        if (total > MAX_QTY) { problems.push(`Max ${MAX_QTY} of ${res.item.name} per order`); continue; }
        found.set(res.item.id, { id: res.item.id, name: res.item.name, price: res.item.price, img: res.item.imageUrl, quantity: total });
    }
    return { items: [...found.values()], problems };
}

function totals(items, fee) {
    const sub = items.reduce((a, i) => a + i.price * i.quantity, 0);
    return { sub, fee, total: sub + fee };
}

function summaryText(items, fee) {
    const t = totals(items, fee);
    let s = items.map(i => `${i.quantity} × ${i.name} — ${money(i.price * i.quantity)}`).join('\n');
    s += `\n\nSubtotal: ${money(t.sub)}\nDelivery: ${money(t.fee)}\n*Total: ${money(t.total)}*`;
    return s;
}

function extractPhone(text, fallback) {
    const m = text.match(/\+?\d[\d\s-]{8,}\d/);
    return m ? m[0].replace(/[\s-]/g, '') : fallback;
}

const STATUS_MESSAGES = {
    Preparing: (id) => `👨‍🍳 Your order *${id}* is now being prepared!`,
    'Out for Delivery': (id) => `🛵 Your order *${id}* is out for delivery. It will reach you soon!`,
    Delivered: (id) => `✅ Your order *${id}* has been delivered. Enjoy your meal! Thank you for choosing JavaGoat 💚`,
    Cancelled: (id) => `❌ Your order *${id}* has been cancelled. Type *menu* to order again.`,
};

// ======================= Message handling =======================
// `send(jid, content)` is injected so this is testable without WhatsApp.
async function handleIncoming({ jid, text, location, send }) {
    const sender = jid.split('@')[0];
    const raw = String(text || '').trim();
    const lower = raw.toLowerCase();
    const words = tokens(raw);
    const reply = (t) => send(jid, { text: t });
    const sk = stateKey(jid);

    const settings = await getSettings();

    // load draft (if any, and not expired)
    let st = await fbGet(`botState/${sk}`);
    if (st && Date.now() - (st.updatedAt || 0) > STATE_TTL_MS) { await fbDelete(`botState/${sk}`); st = null; }
    const saveState = (s) => fbPut(`botState/${sk}`, { ...s, updatedAt: Date.now() });
    const clearState = () => fbDelete(`botState/${sk}`);

    // ----- location pin -----
    if (location) {
        if (!st) return reply('📍 Thanks! Start an order first: type *menu* to see items.');
        st.location = { lat: String(location.lat), lng: String(location.lng) };
        if (st.step === 'ADDRESS') {
            await saveState(st);
            return reply(st.details
                ? '📍 Location received!' + '\n\n' + confirmText(st, settings)
                : '📍 Location received! Now please send your *Name & full delivery address* in one message.');
        }
        await saveState(st);
        return reply('📍 Location updated!\n\n' + confirmText(st, settings));
    }

    if (!raw) return;

    // ----- global commands (work any time) -----
    const isCmd = (...ws) => words.length === 1 && ws.includes(words[0]);

    if (isCmd('help', 'commands')) {
        return reply('🤖 *How to use JavaGoat bot*\n\n• *menu* — see items & prices\n• *order 2 pizza, 1 burger* — place an order\n• *status* — check your last order\n• *cancel* — cancel your current/last order\n• *contact* — talk to us');
    }
    if (isCmd('menu', 'prices', 'price', 'list', 'rates')) {
        const menu = await getMenu();
        return reply(menuText(menu, settings.deliveryFee));
    }
    if (isCmd('contact', 'call', 'support')) {
        return reply('📞 For help, just reply here and our team will get back to you. Type *menu* to order.');
    }
    if (isCmd('status', 'track')) {
        return replyStatus();
    }
    if (isCmd('cancel') && !st) {
        return cancelLastOrder();
    }
    if (st && NO.has(lower) && (st.step === 'CONFIRM' || st.step === 'ADDRESS' || lower === 'cancel')) {
        await clearState();
        return reply('❌ Order cancelled. Type *menu* whenever you want to order again.');
    }

    // ----- start / restart an order -----
    if (/^(order|buy|want|chahiye|mangwa)\b/i.test(raw) || /^order[:\s]/i.test(raw)) {
        if (!settings.isOpen) return reply(`🔒 ${settings.closedMessage}`);
        const body = raw.replace(/^(order|buy|want|chahiye|mangwa)\b[:\s]*/i, '').trim();
        if (!body) return reply('What would you like? Example:\n*order 2 pizza, 1 burger*\n\nType *menu* to see items.');
        const menu = await getMenu();
        const { items, problems } = parseOrderText(body, menu);
        if (problems.length) {
            return reply('⚠️ I could not understand:\n' + problems.map(p => '• ' + p).join('\n') + '\n\nType *menu* to see exact names.');
        }
        if (!items.length) return reply('Please tell me what you want, e.g. *order 2 pizza*.');
        await saveState({ step: 'ADDRESS', items, details: null, location: null, jid });
        const text1 = `🛒 *Your Order*\n${summaryText(items, settings.deliveryFee)}\n\n📝 Now send your *Full Name & Delivery Address* in one message.\n📍 You can also share your Location pin.\nType *cancel* to cancel.`;
        if (items.length === 1 && items[0].img) {
            try { await send(jid, { image: { url: items[0].img }, caption: text1 }); return; } catch (_) { /* fall back to text */ }
        }
        return reply(text1);
    }

    // ----- inside an order draft -----
    if (st && st.step === 'ADDRESS') {
        if (raw.length < 10) return reply('Please send your *Name & full delivery address* (a bit more detail please).');
        st.details = raw.slice(0, 500);
        st.step = 'CONFIRM';
        await saveState(st);
        return reply(confirmText(st, settings));
    }
    if (st && st.step === 'CONFIRM') {
        if (YES.has(lower)) return placeOrder(st);
        if (raw.length >= 10) {   // treat as corrected address
            st.details = raw.slice(0, 500);
            await saveState(st);
            return reply('✏️ Address updated.\n\n' + confirmText(st, settings));
        }
        return reply('Reply *yes* to confirm or *no* to cancel.');
    }

    // ----- greetings / fallback -----
    if (words.some(w => GREETINGS.has(w)) && words.length <= 4) {
        return reply('👋 Welcome to *JavaGoat*!\n\nType *menu* to see our food, or *help* for all commands.');
    }
    return reply('I did not get that 🤔\nType *menu* to see items, or *help* for commands.');

    // ---------- inner helpers ----------
    function confirmText(s, cfg) {
        return `📋 *Please confirm your order*\n\n${summaryText(s.items, cfg.deliveryFee)}\n\n👤 ${s.details}\n📍 Location pin: ${s.location ? 'received ✅' : 'not shared (optional)'}\n\nReply *yes* to confirm or *no* to cancel.\n(Send a new address to change it.)`;
    }

    async function placeOrder(s) {
        const cfg = await getSettings();
        if (!cfg.isOpen) { await clearState(); return reply(`🔒 ${cfg.closedMessage}`); }
        const t = totals(s.items, cfg.deliveryFee);
        const order = {
            userId: `whatsapp_${sender}`,
            userEmail: `WhatsApp: ${sender}`,
            phone: extractPhone(s.details, sender),
            address: s.details,
            location: s.location || { lat: '', lng: '' },
            items: s.items.map(i => ({ id: i.id, name: i.name, price: i.price, quantity: i.quantity, img: i.img || '' })),
            deliveryFee: cfg.deliveryFee,
            total: t.total.toFixed(2),
            status: 'Placed',
            method: 'Cash on Delivery (WhatsApp)',
            timestamp: new Date().toISOString(),
            waJid: jid,
            waNotified: 'Placed',
            adminNotified: false,
        };
        const r = await fbPost('orders', order);
        await clearState();
        return reply(`✅ *Order placed!*\n\nOrder ID: *${shortId(r.name)}*\nTotal: *${money(t.total)}* (pay on delivery)\n\nType *status* anytime to track it. Thank you! 💚`);
    }

    async function latestOrder() {
        const data = await fbGet('orders', { orderBy: 'userId', equalTo: `whatsapp_${sender}`, limitToLast: 20 });
        const list = Object.entries(data || {}).map(([k, v]) => ({ k, ...v }));
        list.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
        return list[0] || null;
    }

    async function replyStatus() {
        const o = await latestOrder();
        if (!o) return reply('You have no orders yet. Type *menu* to start! 🍽️');
        const items = (o.items || []).map(i => `${i.quantity} × ${i.name}`).join(', ');
        return reply(`📦 *Order ${shortId(o.k)}*\n${items}\nTotal: ${money(parseFloat(o.total))}\nStatus: *${o.status}*`);
    }

    async function cancelLastOrder() {
        const o = await latestOrder();
        if (!o) return reply('You have no orders to cancel.');
        if (o.status !== 'Placed') {
            return reply(`Order ${shortId(o.k)} is already *${o.status}*, so it cannot be cancelled here. Please contact us.`);
        }
        await fbPatch(`orders/${o.k}`, { status: 'Cancelled', waNotified: 'Cancelled' });
        return reply(`❌ Order *${shortId(o.k)}* has been cancelled.`);
    }
}

// ======================= Background poller: status updates + admin alerts =======================
let pollBusy = false;
async function pollOrders(getSock) {
    const sock = getSock();
    if (!sock || pollBusy) return;
    pollBusy = true;
    try {
        const since = new Date(Date.now() - POLL_WINDOW_MS).toISOString();
        const data = (await fbGet('orders', { orderBy: 'timestamp', startAt: since, limitToLast: 200 })) || {};
        const settings = await getSettings();

        for (const [key, o] of Object.entries(data)) {
            // 1) tell WhatsApp customers when admin changes their order status
            if (o.waJid && o.status && o.waNotified !== o.status) {
                const msg = STATUS_MESSAGES[o.status];
                if (msg) { try { await sock.sendMessage(o.waJid, { text: msg(shortId(key)) }); } catch (e) { console.log('status notify failed:', e.message); } }
                await fbPatch(`orders/${key}`, { waNotified: o.status });
            }
            // 2) alert admin(s) on WhatsApp about new orders (app + WhatsApp)
            if (!o.adminNotified && o.status === 'Placed' && Date.now() - new Date(o.timestamp).getTime() < ADMIN_ALERT_MAX_AGE_MS) {
                const lat = parseFloat(o.location && o.location.lat), lng = parseFloat(o.location && o.location.lng);
                const items = (o.items || []).map(i => `${i.quantity} × ${i.name}`).join('\n');
                const alert =
                    `🔔 *New order ${shortId(key)}*\n\n${items}\n\nTotal: *${money(parseFloat(o.total))}*\n` +
                    `📞 ${o.phone || '-'}\n📍 ${o.address || '-'}` +
                    ((lat && lng) ? `\n🗺️ https://maps.google.com/?q=${lat},${lng}` : '') +
                    `\n\nVia: ${o.method || 'App'}`;
                for (const n of settings.adminWhatsApp) {
                    try { await sock.sendMessage(`${n}@s.whatsapp.net`, { text: alert }); } catch (e) { console.log('admin alert failed:', e.message); }
                }
                await fbPatch(`orders/${key}`, { adminNotified: true });
            }
        }
    } catch (e) {
        console.log('poll error:', e.message);
    } finally {
        pollBusy = false;
    }
}

// ======================= WhatsApp connection =======================
function startBot() {
    const baileys = require('@whiskeysockets/baileys');
    const { default: makeWASocket, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } = baileys;
    const pino = require('pino');
    const qrcode = require('qrcode-terminal');
    const logger = pino({ level: 'silent' });

    let sock = null;
    let connected = false;
    let pollTimer = null;
    let retryDelay = 3000;
    let pairingRequested = false;
    const rate = new Map(); // jid -> recent timestamps

    const tooFast = (jid) => {
        const now = Date.now();
        const arr = (rate.get(jid) || []).filter(t => now - t < 30000);
        arr.push(now);
        rate.set(jid, arr);
        return arr.length > 15;
    };

    async function connect() {
        const { state, saveCreds } = await useFirebaseAuthState();
        const { version } = await fetchLatestBaileysVersion();
        sock = makeWASocket({
            version,
            auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
            logger,
            browser: ['JavaGoat', 'Chrome', '1.0.0'],
            markOnlineOnConnect: false,
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (u) => {
            const { connection, lastDisconnect, qr } = u;
            if (qr) {
                // Option A (single phone): set PAIRING_NUMBER secret -> get an 8-letter code to type in
                // WhatsApp > Linked devices > Link with phone number instead of scanning a QR.
                const pairNum = (process.env.PAIRING_NUMBER || '').replace(/\D/g, '');
                let usedPairing = false;
                if (pairNum && !sock.authState.creds.registered) {
                    usedPairing = true;
                    if (!pairingRequested) {
                        pairingRequested = true;
                        try {
                            const code = await sock.requestPairingCode(pairNum);
                            console.log(`PAIRING CODE: ${code}   (WhatsApp > Linked devices > Link a device > Link with phone number instead)`);
                        } catch (e) {
                            console.log('Pairing code failed, falling back to QR:', e.message);
                            usedPairing = false;
                        }
                    }
                }
                if (!usedPairing) {
                    console.log('Scan this QR with WhatsApp (Linked Devices):');
                    qrcode.generate(qr, { small: true });
                }
            }
            if (connection === 'open') {
                connected = true;
                retryDelay = 3000;
                console.log('✅ JavaGoat bot connected');
                if (!pollTimer) pollTimer = setInterval(() => pollOrders(() => (connected ? sock : null)), POLL_EVERY_MS);
            }
            if (connection === 'close') {
                connected = false;
                pairingRequested = false;
                const code = lastDisconnect && lastDisconnect.error && lastDisconnect.error.output && lastDisconnect.error.output.statusCode;
                if (code === DisconnectReason.loggedOut) {
                    console.log('Logged out from WhatsApp. Clearing saved session; next run will show a new QR.');
                    try { await fbDelete('botSession'); } catch (e) { console.log(e.message); }
                    process.exit(1);
                }
                console.log(`Connection closed (code ${code}). Reconnecting in ${Math.round(retryDelay / 1000)}s...`);
                setTimeout(() => connect().catch(e => console.log('reconnect failed:', e.message)), retryDelay);
                retryDelay = Math.min(retryDelay * 2, 60000);
            }
        });

        sock.ev.on('messages.upsert', async (m) => {
            if (m.type !== 'notify') return;
            for (const msg of m.messages) {
                try {
                    if (!msg.message || msg.key.fromMe) continue;
                    const jid = msg.key.remoteJid || '';
                    if (!(jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid'))) continue; // private chats only
                    if (tooFast(jid)) { console.log('rate-limited', jid); continue; }

                    let c = msg.message;
                    c = (c.ephemeralMessage && c.ephemeralMessage.message) || c;
                    c = (c.viewOnceMessage && c.viewOnceMessage.message) || c;
                    const text = c.conversation || (c.extendedTextMessage && c.extendedTextMessage.text) || (c.imageMessage && c.imageMessage.caption) || '';
                    const loc = c.locationMessage ? { lat: c.locationMessage.degreesLatitude, lng: c.locationMessage.degreesLongitude } : null;

                    await handleIncoming({
                        jid, text, location: loc,
                        send: (to, content) => sock.sendMessage(to, content),
                    });
                } catch (e) {
                    console.log('handler error:', e.message);
                    try { await sock.sendMessage(msg.key.remoteJid, { text: 'Sorry, something went wrong. Please try again in a moment 🙏' }); } catch (_) { /* ignore */ }
                }
            }
        });
    }

    const shutdown = () => { try { if (sock) sock.end(undefined); } catch (_) { /* ignore */ } process.exit(0); };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
    process.on('unhandledRejection', (e) => console.log('unhandledRejection:', e && e.message ? e.message : e));

    return connect();
}

if (require.main === module) {
    startBot().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
}

module.exports = { handleIncoming, parseOrderText, pollOrders, _internals: { norm, tokens, summaryText, totals } };
