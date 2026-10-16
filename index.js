const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');

// DEBUG - Dekhne ke liye secret aa raha hai ya nahi
console.log("=== DEBUG ===");
console.log("PHONE_NUMBER from Secrets:", process.env.PHONE_NUMBER ? "FOUND" : "NOT FOUND - SECRET NAME GALAT HAI!");
console.log("Raw Value:", process.env.PHONE_NUMBER);
console.log("=============");

const PHONE_RAW = process.env.PHONE_NUMBER || "NOT_FOUND";
const PHONE = PHONE_RAW.replace(/[^0-9]/g, '');

async function start() {
  console.log(`\n>>> TARGET NUMBER: ${PHONE} <<<\n`);
  
  if (PHONE === "" || PHONE === "NOT_FOUND" || PHONE.length < 10) {
    console.log("❌ ERROR: PHONE_NUMBER secret sahi nahi hai!");
    console.log("GitHub Settings > Secrets me PHONE_NUMBER naam se secret banao");
    return;
  }

  const { state, saveCreds } = await useMultiFileAuthState('session_data');
  const { version } = await fetchLatestBaileysVersion();
  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    browser: ["Ubuntu","Chrome","20.0.04"]
  });
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (u) => {
    if (u.connection === 'open') {
      console.log(`\n✅✅ LINKED SUCCESSFULLY - NUMBER: ${PHONE} ✅✅\n`);
    }
  });

  if (!sock.authState.creds.registered) {
    await new Promise(r => setTimeout(r, 3000));
    for (let i = 1; i <= 10; i++) {
      try {
        const code = await sock.requestPairingCode(PHONE);
        console.log("\n========================================");
        console.log(`  NUMBER: ${PHONE}`);
        console.log(`  CODE ${i}: ${code}`);
        console.log("========================================\n");
      } catch (e) {
        console.log(`Error for ${PHONE}: ${e.message}`);
      }
      await new Promise(r => setTimeout(r, 30000));
    }
  }
}
start();
