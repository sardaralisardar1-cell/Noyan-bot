const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');

const FIREBASE_URL = process.env.FIREBASE_URL;
const PHONE_NUMBER = process.env.PHONE_NUMBER;
const orderStates = {};

async function getMenuFromApp() {
    try {
        const r = await fetch(`${FIREBASE_URL}/dishes.json`);
        const d = await r.json();
        if (!d) return [];
        return Object.keys(d).map(k => ({ id: k, name: d[k].name, price: d[k].price }));
    } catch { return []; }
}

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('session_data');
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: ["Ubuntu","Chrome","20.0.04"]
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (u) => {
        if (u.connection === 'open') console.log('✅ LINKED SUCCESSFULLY! JAVA GOAT ONLINE');
        if (u.connection === 'close' && u.lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut) startBot();
    });

    // === PAIRING CODE GENERATOR - Yahi aap chahte ho ===
    if (!sock.authState.creds.registered) {
        await new Promise(r => setTimeout(r, 3000));
        const cleanNumber = PHONE_NUMBER.replace(/[^0-9]/g, '');
        console.log(`Starting pairing for: ${cleanNumber}`);
        while (!sock.authState.creds.registered) {
            try {
                let code = await sock.requestPairingCode(cleanNumber);
                // Code ko EE6M-NR26 format me dikhayega
                console.log(`\n\n================ CODE: ${code} ================\n`);
                console.log(`Is code ko WhatsApp me daalo, 30 sec me naya code ayega agar fail hua\n`);
                await new Promise(r => setTimeout(r, 35000));
            } catch (e) {
                console.log("Retry...", e.message);
                await new Promise(r => setTimeout(r, 5000));
            }
        }
    }

    // === Aapka purana bot logic same hai ===
    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;
        const sender = msg.key.remoteJid;
        const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || "").toLowerCase();
        
        if (orderStates[sender]?.step === 'WAITING_FOR_ADDRESS') {
            const item = orderStates[sender].item;
            const order = { userId: "whatsapp_" + sender.split('@')[0], address: text, items: [{ name: item.name, price: item.price, quantity: 1 }], total: item.price, status: "Placed", timestamp: new Date().toISOString() };
            await fetch(`${FIREBASE_URL}/orders.json`, { method: 'POST', body: JSON.stringify(order) });
            await sock.sendMessage(sender, { text: `✅ Order Placed ${item.name}` });
            delete orderStates[sender]; return;
        }
        if (text.startsWith("order ")) {
            const menu = await getMenuFromApp();
            const item = menu.find(i => i.name.toLowerCase().includes(text.replace("order ","").trim()));
            if(item){ orderStates[sender] = { step: 'WAITING_FOR_ADDRESS', item }; await sock.sendMessage(sender, { text: `🛒 ${item.name} - ₹${item.price}\nAddress bhejo` }); }
        } else if (text.includes("menu")) {
            const menu = await getMenuFromApp();
            let t = "MENU\n"; menu.forEach(i => t += `${i.name} - ${i.price}\n`); await sock.sendMessage(sender, { text: t });
        } else if (text.includes("hi")) {
            await sock.sendMessage(sender, { text: "Welcome to JavaGoat! Type menu" });
        }
    });
}
startBot();
setInterval(()=>{}, 100000);
