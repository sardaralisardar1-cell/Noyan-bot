const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const FIREBASE_URL = process.env.FIREBASE_URL;
const PHONE_NUMBER = process.env.PHONE_NUMBER;
const orderStates = {};

async function getMenuFromApp() {
    try {
        const r = await fetch(`${FIREBASE_URL}/dishes.json`);
        const d = await r.json();
        if (!d) return [];
        return Object.keys(d).map(k => ({ id: k, name: d[k].name, price: d[k].price, imageUrl: d[k].imageUrl }));
    } catch { return []; }
}
async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('session_data');
    const { version } = await fetchLatestBaileysVersion();
    const sock = makeWASocket({ version, auth: state, printQRInTerminal: false, logger: pino({ level: 'silent' }), browser: ["Chrome","Chrome","1.0"] });
    if (!sock.authState.creds.registered) {
        await new Promise(r => setTimeout(r, 3000));
        const code = await sock.requestPairingCode(PHONE_NUMBER.replace(/[^0-9]/g, ''));
        console.log(`\n🔑 PAIRING CODE: ${code}\n`);
    }
    sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
        if (connection === 'open') console.log('✅ JAVAGOAT ONLINE!');
        if (connection === 'close' && lastDisconnect?.error?.output?.statusCode!== DisconnectReason.loggedOut) startBot();
    });
    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0]; if (!msg.message || msg.key.fromMe) return;
        const sender = msg.key.remoteJid;
        const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || "").toLowerCase();
        if (orderStates[sender]?.step === 'WAITING_FOR_ADDRESS') {
            const item = orderStates[sender].item;
            const order = { userId: "whatsapp_" + sender.split('@')[0], phone: sender.split('@')[0], address: text, items: [{ id: item.id, name: item.name, price: parseFloat(item.price), quantity: 1 }], total: (parseFloat(item.price)+50).toFixed(2), status: "Placed", timestamp: new Date().toISOString() };
            await fetch(`${FIREBASE_URL}/orders.json`, { method: 'POST', body: JSON.stringify(order) });
            await sock.sendMessage(sender, { text: `✅ Order Placed! ${item.name} - ₹${order.total}` });
            delete orderStates[sender]; return;
        }
        if (text.startsWith("order ")) {
            const menu = await getMenuFromApp();
            const item = menu.find(i => i.name.toLowerCase().includes(text.replace("order ","").trim()));
            if (!item) { await sock.sendMessage(sender, { text: "❌ Not found. Type menu" }); return; }
            orderStates[sender] = { step: 'WAITING_FOR_ADDRESS', item };
            await sock.sendMessage(sender, { text: `🛒 ${item.name} - ₹${item.price}\nReply with Name, Address` });
        } else if (text.includes("menu")) {
            const menu = await getMenuFromApp();
            let t = "🍔 *MENU* 🍕\n"; menu.forEach(i => t += `🔸 ${i.name} - ₹${i.price}\n`);
            await sock.sendMessage(sender, { text: t });
        } else if (text.includes("hi")) {
            await sock.sendMessage(sender, { text: "👋 Welcome to JavaGoat! Type menu" });
        }
    });
}
startBot();
