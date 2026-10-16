const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
async function start() {
  const { state, saveCreds } = await useMultiFileAuthState('session_data');
  const { version } = await fetchLatestBaileysVersion();
  const sock = makeWASocket({ version, auth: state, logger: pino({ level: 'silent' }), browser: ["Ubuntu","Chrome","20.0.04"] });
  if (!sock.authState.creds.registered) {
    await new Promise(r=>setTimeout(r, 4000));
    const code = await sock.requestPairingCode(process.env.PHONE_NUMBER.replace(/[^0-9]/g,''));
    console.log("YOUR CODE IS: " + code);
  }
  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', u=>{ if(u.connection==='open') console.log("LINKED!"); });
}
start();
