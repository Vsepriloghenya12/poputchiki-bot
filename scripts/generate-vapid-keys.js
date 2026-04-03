const webpush = require('web-push');

const keys = webpush.generateVAPIDKeys();

console.log('Добавьте это в .env:');
console.log(`WEB_PUSH_PUBLIC_KEY=${keys.publicKey}`);
console.log(`WEB_PUSH_PRIVATE_KEY=${keys.privateKey}`);
console.log('WEB_PUSH_SUBJECT=mailto:you@example.com');
