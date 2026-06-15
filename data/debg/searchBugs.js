const fs = require('fs');

const archivo = process.argv[2];

if (!archivo) {
    console.log('Uso: node searchBugs.js archivo.json');
    process.exit(1);
}

try {
    const data = JSON.parse(fs.readFileSync(archivo, 'utf8'));

    const uids = new Map();

    for (const [slug, uid] of Object.entries(data)) {
        if (!uids.has(uid)) {
            uids.set(uid, []);
        }
        uids.get(uid).push(slug);
    }

    let encontrados = 0;

    for (const [uid, slugs] of uids.entries()) {
        if (slugs.length > 1) {
            encontrados++;
            console.log(`UID repetido: ${uid}`);
            console.log(`  ${slugs.join(', ')}`);
            console.log('');
        }
    }

    if (encontrados === 0) {
        console.log('No se encontraron UIDs repetidos.');
    } else {
        console.log(`Total de UIDs repetidos: ${encontrados}`);
    }

} catch (err) {
    console.error('Error:', err.message);
}