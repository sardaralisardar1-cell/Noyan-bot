const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');

const FIREBASE_URL = process.env.FIREBASE_URL;
const RAW_NUMBER = process.env.PHONE_NUMBER;
const PHONE = RAW_NUMBER.replace(/[^0-9]/g, '');
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
    console.log("=== JavaGoat Starting ===");
    console.log(`Target Number: ${PHONE} (Original: ${RAW_NUMBER})`);
    
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
    
    let isLinked = false;
    sock.ev.on('connection.update', (u) => {
        if (u.connection === 'open') {
            isLinked = true;
            console.log('\n✅✅✅ LINKED! BOT ONLINE ✅✅✅\n');
        }
    });

    if (!sock.authState.creds.registered) {
        await new Promise(r => setTimeout(r, 3000));
        let attempt = 1;
        while (!isLinked) {
            try {
                const code = await sock.requestPairingCode(PHONE);
                
                // ===== YAHAN NUMBER + CODE DONO DIKHEGA =====
                console.log("\n========================================");
                console.log(`  NUMBER: ${PHONE}`);
                console.log(`  CODE: ${code}`);
                console.log("========================================");
                console.log(`  WhatsApp > Linked Devices >`);
                console.log(`  Link with phone number > Enter Code: ${code}`);
                console.log("========================================\n");
                
                console.log(`Attempt ${attempt} - 35 sec me naya code ayega agar link nahi hua\n`);
                
            } catch (e) {
                console.log("Error: " + e.message + " - Restarting...");
                setTimeout(() => startBot(), 3000);
                return;
            }
            
            await new Promise(r => setTimeout(r, 35000));
            
            if (!isLinked) {
                console.log(`\n❌ CODE EXPIRED for ${PHONE}, Generating NEW CODE...\n`);
                attempt++;
                if (attempt % 3 === 0) {
                    console.log(`Restarting for fresh code for ${PHONE}...`);
                    setTimeout(() => startBot(), 2000);
                    return;
                }
            }
        }
    }

    // Aapka menu/order wala code same hai
    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;
        const sender = msg.key.remoteJid;
        const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || "").toLowerCase();
        if (orderStates[sender]?.step === 'WAITING_FOR_ADDRESS') {
            const item = orderStates[sender].item;
            const order = { address: text, items: [{ name: item.name, price: item.price }], status: "Placed", timestamp: new Date().toISOString() };
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
            await sock.sendMessage(sender, { text: "Welcome! Type menu" });
        }
    });
}
startBot();
