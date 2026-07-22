#!/usr/bin/env node
/**
 * Direct printer hardware test — no server involved.
 * Sends a test ticket straight to the printer: over TCP 9100 (network
 * printers) or through a raw CUPS queue (USB printers).
 *
 * Usage:
 *   node test-printer.js 192.168.1.200         # network printer
 *   node test-printer.js 192.168.1.200:9100
 *   node test-printer.js usb:termica           # USB printer (CUPS queue)
 *
 * If this prints, the printer hardware is fine and any remaining issue
 * is in the bridge config or the server.
 */

import net from 'node:net';
import { spawn } from 'node:child_process';

const arg = process.argv[2];
if (!arg) {
  console.error('Usage: node test-printer.js <printer-ip>[:port] | usb:<cups-queue>');
  process.exit(1);
}
const isUsb = /^(usb|cups):/i.test(arg);
const queue = arg.replace(/^(usb|cups):/i, '').trim();
const [host, portStr] = arg.split(':');
const port = Number(portStr) || 9100;

// Minimal inline ESC/POS test ticket (CP850 for Spanish accents)
const ESC = 0x1b, GS = 0x1d;
const enc = (s) => {
  const map = { 'á':0xa0,'é':0x82,'í':0xa1,'ó':0xa2,'ú':0xa3,'ñ':0xa4,'Ñ':0xa5,'ü':0x81,'¿':0xa8,'¡':0xad,'°':0xf8 };
  return Buffer.from([...s].map(c => c.codePointAt(0) < 0x80 ? c.codePointAt(0) : (map[c] ?? 0x3f)));
};
const LF = Buffer.from([0x0a]);

const ticket = Buffer.concat([
  Buffer.from([ESC, 0x40]),            // init
  Buffer.from([ESC, 0x74, 0x02]),      // codepage PC850
  Buffer.from([ESC, 0x61, 0x01]),      // center
  Buffer.from([GS, 0x21, 0x11]),       // double size
  enc('PRUEBA DIRECTA'), LF,
  Buffer.from([GS, 0x21, 0x00]),       // normal size
  enc(isUsb ? `USB (cola CUPS: ${queue})` : `${host}:${port}`), LF,
  enc(new Date().toLocaleString('es-MX')), LF,
  Buffer.from([ESC, 0x61, 0x00]),      // left
  enc('='.repeat(42)), LF,
  enc('Acentos: á é í ó ú ñ Ñ ü ¿ ¡ °'), LF,
  enc('Si ves este ticket, la impresora'), LF,
  enc('y la red funcionan correctamente.'), LF,
  enc('='.repeat(42)), LF,
  Buffer.from([ESC, 0x64, 0x03]),      // feed 3
  Buffer.from([GS, 0x56, 0x42, 0x00]), // partial cut
]);

if (isUsb) {
  console.log(`Sending to CUPS queue "${queue}" (lp -o raw)...`);
  const lp = spawn('lp', ['-d', queue, '-o', 'raw', '-s'], { stdio: ['pipe', 'inherit', 'inherit'] });
  lp.once('error', (err) => {
    console.error(`FAILED: lp not available: ${err.message}`);
    process.exit(1);
  });
  lp.once('close', (code) => {
    if (code === 0) {
      console.log('OK — ticket sent to CUPS. Check the printer.');
      console.log('If nothing prints: is the USB cable in? Queue paused? Run: lpstat -p ' + queue);
      process.exit(0);
    }
    console.error(`FAILED: lp exited ${code}. Does the queue exist? Run: lpstat -p`);
    console.error('To create a raw USB queue, run: ./setup-usb-macos.sh');
    process.exit(1);
  });
  lp.stdin.end(ticket);
} else {

console.log(`Connecting to ${host}:${port}...`);
const socket = new net.Socket();
socket.setTimeout(8000, () => {
  console.error('TIMEOUT — check the IP, the cable, and that the printer is on the same network.');
  socket.destroy();
  process.exit(1);
});
socket.once('error', (err) => {
  console.error(`FAILED: ${err.message}`);
  console.error('Check: printer powered on? Ethernet cable in? IP correct? (print the self-test page: hold FEED while powering on)');
  process.exit(1);
});
socket.connect(port, host, () => {
  socket.end(ticket, () => {
    setTimeout(() => {
      console.log('OK — ticket sent. Check the printer.');
      process.exit(0);
    }, 500);
  });
});

}
