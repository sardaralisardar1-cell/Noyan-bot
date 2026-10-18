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

// Privacy: mask long digit runs (phone numbers) in logs, in case the repo / Actions logs are public.
const _origLog = console.log.bind(console);
console.log = (...args) => _origLog(...args.map(a => (typeof a === 'string'
    ? a.replace(/\d{8,}/g, m => m.slice(0, 3) + '***' + m.slice(-2)) : a)));

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
            deliveryEnabled: s.deliveryEnabled !== false,
            shopAddress: String(s.shopAddress || '').slice(0, 200),
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
        .map(([id, d]) => {
            const num = parseInt(d.number, 10);
            return {
                id,
                name: String(d.name || ''),
                price: parseFloat(d.price),
                imageUrl: d.imageUrl || '',
                number: (Number.isFinite(num) && num > 0) ? num : null,
            };
        })
        .filter(d => d.name && !isNaN(d.price))
        .sort((a, b) => ((a.number ?? 1e9) - (b.number ?? 1e9)) || a.name.localeCompare(b.name));
}

function menuText(menu, cfg) {
    if (!menu.length) return 'Menu is empty right now. Please check back soon!';
    let t = '🍽️ *JavaGoat Menu*\n\n';
    menu.forEach(i => { t += `${i.number ? `*${i.number}.*` : '•'} ${i.name} — ${money(i.price)}\n`; });
    t += '\n👉 Order ke liye product ka *number* bhejein (jaise *2*).';
    t += '\nYa likhein: *order 2 pizza, 1 burger*';
    t += cfg.deliveryEnabled ? `\n\n🛵 Delivery: ${money(cfg.deliveryFee)} | 🛍️ Pickup: free` : '\n\n🛍️ Abhi sirf shop se pickup available hai.';
    return t;
}

// Parse "order 2 pizza, 1 burger x2" against the menu (name based).
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

const itemLines = (items) => items.map(i => `${i.quantity} × ${i.name} — ${money(i.price * i.quantity)}`).join('\n');

// type: 'Delivery' adds a delivery line; anything else (Pickup) has no delivery fee
function summaryText(items, fee, type) {
    const t = totals(items, type === 'Delivery' ? fee : 0);
    let s = itemLines(items);
    s += `\n\nSubtotal: ${money(t.sub)}`;
    if (type === 'Delivery') s += `\nDelivery: ${money(t.fee)}`;
    s += `\n*Total: ${money(t.total)}*`;
    return s;
}

function extractPhone(text, fallback) {
    const m = text.match(/\+?\d[\d\s-]{8,}\d/);
    return m ? m[0].replace(/[\s-]/g, '') : fallback;
}

// (id, order, settings) -> text
const STATUS_MESSAGES = {
    Preparing: (id) => `👨‍🍳 Your order *${id}* is now being prepared!`,
    'Ready for Pickup': (id, o, cfg) => `✅ Aap ka order *${id}* tayar hai! Shop se utha lein.${cfg.shopAddress ? `\n📍 ${cfg.shopAddress}` : ''}`,
    'Out for Delivery': (id) => `🛵 Your order *${id}* is out for delivery. It will reach you soon!`,
    Delivered: (id, o) => (o.orderType === 'Pickup'
        ? `✅ Order *${id}* aap ko mil gaya. Shukriya! 💚`
        : `✅ Your order *${id}* has been delivered. Enjoy! Thank you for choosing JavaGoat 💚`),
    Cancelled: (id) => `❌ Your order *${id}* has been cancelled. Type *menu* to order again.`,
};

// ======================= Message handling =======================
// `send(jid, content)` is injected so this is testable without WhatsApp.
//
// Order flow (state.step):
//   QTY     -> customer sent a product number, we wait for quantity
//   TYPE    -> 1 = Pickup (booking only), 2 = Booking + Delivery
//   NAME    -> pickup: wait for name
//   ADDRESS -> delivery: wait for name + address (or location pin)
//   CONFIRM -> 1 = confirm, 2 = cancel
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
        if (!st) return reply('📍 Thanks! Pehle order shuru karein: *menu* likhein ya product ka number bhejein.');
        if (st.orderType === 'Pickup') return reply('📍 Pickup order mein location ki zaroorat nahi. Jawab dein ya *cancel* likhein.');
        if (st.step === 'ADDRESS' || st.step === 'CONFIRM') {
            st.location = { lat: String(location.lat), lng: String(location.lng) };
            await saveState(st);
            return reply(st.step === 'CONFIRM'
                ? '📍 Location updated!\n\n' + confirmText(st, settings)
                : '📍 Location received! Ab apna *Naam aur poora address* ek message mein bhejein.');
        }
        return reply('📍 Location baad mein maangenge. Pehle upar wale sawal ka jawab dein.');
    }

    if (!raw) return;

    // ----- global commands (work any time) -----
    const isCmd = (...ws) => words.length === 1 && ws.includes(words[0]);

    if (isCmd('help', 'commands')) {
        return reply('🤖 *How to use JavaGoat bot*\n\n• *menu* — items aur numbers\n• *2* — product number bhejein (details + order)\n• *p3* — koi bhi waqt product 3 dekhein\n• *order 2 pizza, 1 burger* — naam se order\n• *status* — apka aakhri order\n• *cancel* — cancel karein\n• *contact* — hum se baat karein');
    }
    if (isCmd('menu', 'prices', 'price', 'list', 'rates')) {
        const menu = await getMenu();
        return reply(menuText(menu, settings));
    }
    if (isCmd('contact', 'call', 'support')) {
        return reply('📞 Madad ke liye yahin message likhein, hamari team jawab degi. Menu ke liye *menu* likhein.');
    }
    if (isCmd('status', 'track')) {
        return replyStatus();
    }
    if (isCmd('cancel') && !st) {
        return cancelLastOrder();
    }
    if (st && (lower === 'cancel' || (NO.has(lower) && st.step !== 'NAME' && st.step !== 'ADDRESS'))) {
        await clearState();
        return reply('❌ Order cancel ho gaya. Dobara order ke liye *menu* likhein.');
    }

    // ----- product by number from anywhere: p3 / product 3 / #3 -----
    const pm = lower.match(/^(?:p|prod|product|item|#)\s*(\d{1,4})$/);
    if (pm) return showProduct(parseInt(pm[1], 10));

    // ----- order by name: "order 2 pizza, 1 burger" -----
    if (/^(order|buy|want|chahiye|mangwa)\b/i.test(raw)) {
        if (!settings.isOpen) return reply(`🔒 ${settings.closedMessage}`);
        const body = raw.replace(/^(order|buy|want|chahiye|mangwa)\b[:\s]*/i, '').trim();
        if (!body) return reply('Kya chahiye? Product ka number bhejein (jaise *2*) ya likhein:\n*order 2 pizza, 1 burger*\n\n*menu* likhein list ke liye.');
        const menu = await getMenu();
        const { items, problems } = parseOrderText(body, menu);
        if (problems.length) {
            return reply('⚠️ Samajh nahi aaya:\n' + problems.map(p => '• ' + p).join('\n') + '\n\n*menu* likhein, exact naam/number ke liye.');
        }
        if (!items.length) return reply('Batayein kya chahiye, jaise *order 2 pizza*.');
        return goToTypeStep({ items, details: null, location: null, jid });
    }

    // ----- a bare number -----
    if (/^\d{1,4}$/.test(raw)) {
        const n = parseInt(raw, 10);
        if (!st) return showProduct(n);
        if (st.step === 'QTY') return setQuantity(n);
        if (st.step === 'TYPE') return chooseType(n === 1 ? 'Pickup' : n === 2 ? 'Delivery' : null);
        if (st.step === 'CONFIRM') {
            if (n === 1) return placeOrder(st);
            if (n === 2) { await clearState(); return reply('❌ Order cancel ho gaya. Dobara order ke liye *menu* likhein.'); }
            return reply('Confirm ke liye *1*, cancel ke liye *2* bhejein.');
        }
        // NAME / ADDRESS: falls through to the text handlers below
    }

    // ----- inside an order draft (text answers) -----
    if (st && st.step === 'QTY') {
        const m = lower.match(/^(\d{1,3})\s*(?:x|pcs?|pairs?|pair|pieces?)$/);
        if (m) return setQuantity(parseInt(m[1], 10));
        return reply(`Quantity number mein bhejein (1 se ${MAX_QTY}), jaise *2*.`);
    }
    if (st && st.step === 'TYPE') {
        if (words.includes('delivery') || words.includes('deliver')) return chooseType('Delivery');
        if (words.includes('pickup') || words.includes('booking') || words.includes('book')) return chooseType('Pickup');
        return reply(typeQuestion(st, settings));
    }
    if (st && st.step === 'NAME') {
        if (raw.length < 2) return reply('Apna *naam* bhejein.');
        st.details = raw.slice(0, 200);
        st.step = 'CONFIRM';
        await saveState(st);
        return reply(confirmText(st, settings));
    }
    if (st && st.step === 'ADDRESS') {
        if (raw.length < 10) return reply('Apna *Naam aur poora delivery address* bhejein (thodi aur detail ke sath).');
        st.details = raw.slice(0, 500);
        st.step = 'CONFIRM';
        await saveState(st);
        return reply(confirmText(st, settings));
    }
    if (st && st.step === 'CONFIRM') {
        if (YES.has(lower)) return placeOrder(st);
        if (st.orderType === 'Delivery' && raw.length >= 10) {   // treat as corrected address
            st.details = raw.slice(0, 500);
            await saveState(st);
            return reply('✏️ Address update ho gaya.\n\n' + confirmText(st, settings));
        }
        return reply('Confirm ke liye *1*, cancel ke liye *2* bhejein.');
    }

    // ----- greetings / fallback -----
    if (words.some(w => GREETINGS.has(w)) && words.length <= 4) {
        return reply('👋 Welcome to *JavaGoat*!\n\n*menu* likhein ya seedha product ka *number* bhejein (jaise *2*).\nMadad ke liye *help* likhein.');
    }
    return reply('Samajh nahi aaya 🤔\n*menu* likhein ya product ka number bhejein, ya *help* likhein.');

    // ---------- inner helpers (hoisted) ----------
    async function showProduct(n) {
        const menu = await getMenu();
        const item = menu.find(m => m.number === n);
        if (!item) return reply(`❌ Product number *${n}* nahi mila. Poori list ke liye *menu* likhein.`);
        if (!settings.isOpen) return reply(`🛍️ *${item.number}. ${item.name}* — ${money(item.price)}\n\n🔒 ${settings.closedMessage}`);
        await saveState({ step: 'QTY', items: [{ id: item.id, name: item.name, price: item.price, img: item.imageUrl, quantity: null }], orderType: null, details: null, location: null, jid });
        const cap = `🛍️ *${item.number}. ${item.name}*\nPrice: *${money(item.price)}*\n\n📦 Kitni quantity chahiye? Number bhejein (jaise *1* ya *2*).\n(Doosra product: *p3* | wapas: *cancel*)`;
        if (item.imageUrl) {
            try { await send(jid, { image: { url: item.imageUrl }, caption: cap }); return; } catch (_) { /* fall back to text */ }
        }
        return reply(cap);
    }

    async function setQuantity(n) {
        if (n < 1 || n > MAX_QTY) return reply(`Quantity 1 se ${MAX_QTY} ke beech bhejein.`);
        st.items[0].quantity = n;
        return goToTypeStep(st);
    }

    function typeQuestion(s, cfg) {
        const sub = totals(s.items, 0).sub;
        return `🛒 *Your Order*\n${itemLines(s.items)}\nSubtotal: ${money(sub)}\n\nOrder kaise chahiye? Number bhejein:\n*1* — Sirf Booking (shop se khud uthayen, free)\n*2* — Booking + Delivery (delivery ${money(cfg.deliveryFee)})\n\n*cancel* likhein to cancel.`;
    }

    async function goToTypeStep(s) {
        if (!settings.isOpen) return reply(`🔒 ${settings.closedMessage}`);
        if (!settings.deliveryEnabled) {
            s.orderType = 'Pickup'; s.step = 'NAME';
            await saveState(s);
            return reply(`🛒 *Your Order*\n${summaryText(s.items, 0, 'Pickup')}\n\n🛍️ Abhi sirf shop se pickup available hai.\n📝 Booking ke liye apna *naam* bhejein.\n*cancel* likhein to cancel.`);
        }
        s.orderType = null; s.step = 'TYPE';
        await saveState(s);
        return reply(typeQuestion(s, settings));
    }

    async function chooseType(kind) {
        if (!kind) return reply(typeQuestion(st, settings));
        if (kind === 'Delivery' && !settings.deliveryEnabled) { kind = 'Pickup'; }
        st.orderType = kind;
        if (kind === 'Pickup') {
            st.step = 'NAME';
            await saveState(st);
            return reply('🛍️ *Pickup / Booking*\n\n📝 Apna *naam* bhejein (booking isi naam se hogi).\n*cancel* likhein to cancel.');
        }
        st.step = 'ADDRESS';
        await saveState(st);
        return reply('🛵 *Booking + Delivery*\n\n📝 Apna *Naam aur poora delivery address* ek message mein bhejein.\n📍 Chahein to Location pin bhi share kar sakte hain.\n*cancel* likhein to cancel.');
    }

    function confirmText(s, cfg) {
        const isPickup = s.orderType === 'Pickup';
        let t = `📋 *Please confirm your order*\n\n${summaryText(s.items, cfg.deliveryFee, s.orderType)}\n\n`;
        if (isPickup) {
            t += `🛍️ *Pickup (shop se)*\n👤 ${s.details}`;
            if (cfg.shopAddress) t += `\n📍 ${cfg.shopAddress}`;
            t += '\n\nConfirm ke liye *1*, cancel ke liye *2* bhejein.';
        } else {
            t += `🛵 *Delivery*\n👤 ${s.details}\n📍 Location pin: ${s.location ? 'received ✅' : 'not shared (optional)'}`;
            t += '\n\nConfirm ke liye *1*, cancel ke liye *2* bhejein.\n(Address badalna ho to naya address bhejein.)';
        }
        return t;
    }

    async function placeOrder(s) {
        const cfg = await getSettings();
        if (!cfg.isOpen) { await clearState(); return reply(`🔒 ${cfg.closedMessage}`); }
        const isPickup = s.orderType === 'Pickup';
        if (!isPickup && !cfg.deliveryEnabled) {
            await clearState();
            return reply('🚫 Delivery abhi band hai. Dobara order karein aur *1* (Pickup) chunein.');
        }
        const fee = isPickup ? 0 : cfg.deliveryFee;
        const t = totals(s.items, fee);
        const order = {
            userId: `whatsapp_${sender}`,
            userEmail: `WhatsApp: ${sender}`,
            phone: extractPhone(s.details, sender),
            address: isPickup ? `Pickup (shop se) — ${s.details}` : s.details,
            location: (!isPickup && s.location) ? s.location : { lat: '', lng: '' },
            items: s.items.map(i => ({ id: i.id, name: i.name, price: i.price, quantity: i.quantity, img: i.img || '' })),
            deliveryFee: fee,
            orderType: isPickup ? 'Pickup' : 'Delivery',
            total: t.total.toFixed(2),
            status: 'Placed',
            method: isPickup ? 'Pay at Shop (WhatsApp)' : 'Cash on Delivery (WhatsApp)',
            timestamp: new Date().toISOString(),
            waJid: jid,
            waNotified: 'Placed',
            adminNotified: false,
        };
        const r = await fbPost('orders', order);
        await clearState();
        if (isPickup) {
            return reply(`✅ *Booking ho gayi!*\n\nOrder ID: *${shortId(r.name)}*\nTotal: *${money(t.total)}* (shop par pay karein)${cfg.shopAddress ? `\n📍 ${cfg.shopAddress}` : ''}\n\nOrder tayar hote hi hum aap ko yahin message karenge. *status* likh kar bhi check kar sakte hain. Shukriya! 💚`);
        }
        return reply(`✅ *Order placed!*\n\nOrder ID: *${shortId(r.name)}*\nTotal: *${money(t.total)}* (delivery par pay karein)\n\n*status* likh kar kisi bhi waqt track karein. Shukriya! 💚`);
    }

    async function latestOrder() {
        const data = await fbGet('orders', { orderBy: 'userId', equalTo: `whatsapp_${sender}`, limitToLast: 20 });
        const list = Object.entries(data || {}).map(([k, v]) => ({ k, ...v }));
        list.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
        return list[0] || null;
    }

    async function replyStatus() {
        const o = await latestOrder();
        if (!o) return reply('Abhi tak koi order nahi hai. *menu* likh kar shuru karein! 🍽️');
        const items = (o.items || []).map(i => `${i.quantity} × ${i.name}`).join(', ');
        return reply(`📦 *Order ${shortId(o.k)}*\n${o.orderType === 'Pickup' ? '🛍️ Pickup' : '🛵 Delivery'}\n${items}\nTotal: ${money(parseFloat(o.total))}\nStatus: *${o.status}*`);
    }

    async function cancelLastOrder() {
        const o = await latestOrder();
        if (!o) return reply('Cancel karne ke liye koi order nahi hai.');
        if (o.status !== 'Placed') {
            return reply(`Order ${shortId(o.k)} ab *${o.status}* hai, yahan se cancel nahi ho sakta. Please humse rabta karein.`);
        }
        await fbPatch(`orders/${o.k}`, { status: 'Cancelled', waNotified: 'Cancelled' });
        return reply(`❌ Order *${shortId(o.k)}* cancel ho gaya.`);
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
                if (msg) { try { await sock.sendMessage(o.waJid, { text: msg(shortId(key), o, settings) }); } catch (e) { console.log('status notify failed:', e.message); } }
                await fbPatch(`orders/${key}`, { waNotified: o.status });
            }
            // 2) alert admin(s) on WhatsApp about new orders (app + WhatsApp)
            if (!o.adminNotified && o.status === 'Placed' && Date.now() - new Date(o.timestamp).getTime() < ADMIN_ALERT_MAX_AGE_MS) {
                const isPickup = o.orderType === 'Pickup';
                const lat = parseFloat(o.location && o.location.lat), lng = parseFloat(o.location && o.location.lng);
                const items = (o.items || []).map(i => `${i.quantity} × ${i.name}`).join('\n');
                const alert =
                    `🔔 *New order ${shortId(key)}*\n${isPickup ? '🛍️ PICKUP (booking only)' : '🛵 DELIVERY'}\n\n${items}\n\nTotal: *${money(parseFloat(o.total))}*\n` +
                    `📞 ${o.phone || '-'}\n📍 ${o.address || '-'}` +
                    ((!isPickup && lat && lng) ? `\n🗺️ https://maps.google.com/?q=${lat},${lng}` : '') +
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
    const { default: makeWASocket, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, Browsers } = baileys;
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
            browser: Browsers.ubuntu('Chrome'),   // must be a standard browser id, custom names break pairing codes
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
                            console.log(`PAIRING CODE: ${code}  [${new Date().toISOString()}]  (WhatsApp > Linked devices > Link a device > Link with phone number instead). Use the NEWEST code only.`);
                        } catch (e) {
                            console.log('Pairing code failed:', e.message);
                            usedPairing = false;
                        }
                    }
                }
                if (!usedPairing) {
                    // A QR in a PUBLIC repo's Actions log could be scanned by anyone -> hidden unless ALLOW_QR=1
                    if (process.env.ALLOW_QR === '1') {
                        console.log('Scan this QR with WhatsApp (Linked Devices):');
                        qrcode.generate(qr, { small: true });
                    } else {
                        console.log('Not linked yet. Set the PAIRING_NUMBER secret (QR is hidden for safety) and run again.');
                    }
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
                    if (tooFast(jid)) continue;

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
