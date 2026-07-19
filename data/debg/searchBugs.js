const fs = require('fs');

const archivo = process.argv[2];

if (!archivo) {
    console.log('Uso: node searchBugs.js archivo.json');
    process.exit(1);
}

try {
    const data = JSON.parse(fs.readFileSync(archivo, 'utf8'));

    // Validar que exista la lista de animes
    if (!data.animes || !Array.isArray(data.animes)) {
        console.error('Error: El archivo JSON no tiene el formato esperado (falta el array "animes").');
        process.exit(1);
    }

    const uids = new Map();

    // Cambiamos el bucle para iterar sobre el array de objetos
    for (const anime of data.animes) {
        const slug = anime.slug;
        const uid = anime.unit_id; // En tu JSON la propiedad se llama unit_id

        // Saltarse elementos que no tengan estas propiedades definidas
        if (!slug || !uid) continue;

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
            console.log(`  Slugs: ${slugs.join(', ')}`);
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