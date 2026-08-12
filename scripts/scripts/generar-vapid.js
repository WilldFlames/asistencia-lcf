const webpush = require("web-push");

const claves = webpush.generateVAPIDKeys();

console.log("\nCopie estas variables en Railway > servicio Web > Variables:\n");
console.log(`VAPID_PUBLIC_KEY=${claves.publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${claves.privateKey}`);
console.log("VAPID_SUBJECT=https://www.liccallefallas.com");
console.log("\nGuarde ambas claves. No genere otras después de que las familias activen sus teléfonos.\n");
