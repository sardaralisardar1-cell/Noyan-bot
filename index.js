const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const FIREBASE_URL = process.env.FIREBASE_URL;
const PHONE_NUMBER = process.env.PHONE_NUMBER;

async function startBot() {
    console.log("Starting bot...");
    // Pehle purana session delete karo taaki naya code mile
    const { state, saveCreds } = await useMultiFileAuthState('session_data');
    const { version } = await fetchLatestBaileysVersion();
    const sock = makeWASocket({ 
        version, 
        auth: state, 
        printQRInTerminal: false, 
        logger: pino({ level: 'silent' }),
        browser: ["Ubuntu","Chrome","20.0.04"]
    });

    if (!sock.authState.creds.registered) {
        console.log("Requesting Pairing Code...");
        await new Promise(r => setTimeout(r, 5000)); // 5 sec wait zaroori hai
        try {
            const num = PHONE_NUMBER.replace(/[^0-9]/g, '');
            console.log("For Number: " + num);
            const code = await sock.requestPairingCode(num);
            console.log("\n=============================");
            console.log("CODE: " + code);
            console.log("=============================\n");
            console.log("Is code ko 20 second ke andar WhatsApp me dalo!");
        } catch (e) { 
            console.log("Error: ", e.message);
            console.log("Session folder delete karke dobara try karo");
        }
    }

    sock.ev.on('connection.update', ({ connection }) => {
        if (connection === 'open') console.log('✅ LINKED SUCCESSFULLY!');
    });
    sock.ev.on('creds.update', saveCreds);
}
startBot();
