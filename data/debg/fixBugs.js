const fs = require('fs');

const archivo = process.argv[2];

if (!archivo) {
    console.log('Uso: node reparar-unitids.js archivo.json');
    process.exit(1);
}

const data = JSON.parse(fs.readFileSync(archivo, 'utf8'));

const usados = new Set(Object.values(data));
let maxId = Math.max(...usados);

const vistos = new Map();
let cambios = 0;

for (const [slug, uid] of Object.entries(data)) {
    if (!vistos.has(uid)) {
        vistos.set(uid, slug);
        continue;
    }

    // UID repetido
    do {
        maxId++;
    } while (usados.has(maxId));

    console.log(
        `${slug}: UID repetido ${uid} → nuevo UID ${maxId}`
    );

    data[slug] = maxId;
    usados.add(maxId);
    cambios++;
}

fs.writeFileSync(
    archivo,
    JSON.stringify(data, null, 2),
    'utf8'
);

console.log(`\n${cambios} UIDs reparados.`);