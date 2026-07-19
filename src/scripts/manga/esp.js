const axios = require('axios');
const fs = require('fs');
const path = require('path');

const outfolder = path.join(__dirname, 'esp');

if (!fs.existsSync(outfolder)) {
    fs.mkdirSync(outfolder);
}

async function getpags() {
    const res = await axios.get("https://mangalect.org/api/buscar_mangas/?page=1&page_size=50", {
        headers: {
            'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0',
            'Accept': 'application/json, text/javascript, */*; q=0.01',
            'Accept-Language': 'es-ES,es;q=0.8,en-US;q=0.5,en;q=0.3',
            'X-Requested-With': 'XMLHttpRequest',
            'Referer': "https://mangalect.org/api/buscar_mangas/?page=1&page_size=50",
            'Sec-Fetch-Dest': 'empty',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Site': 'same-origin'
        },
        timeout: 25000
    });
    const data = res.data;
    const lastp = data.total_pages;
    return lastp;
}

async function downloadData() {
    const paginit = 1;
    const pagend = await getpags();
    const batch_size = 20;
    const pag = [];
    for (let i = paginit; i <= pagend; i++) {
        pag.push(i);
    }

    for (let i = 0; i < pag.length; i += batch_size) {
        const batchCurrent = pag.slice(i, i + batch_size);

        const promBatch = batchCurrent.map(async (page) => {
            const url = `https://mangalect.org/api/buscar_mangas/?page=${page}&page_size=50`;
            const refererUrl = `https://mangalect.org/api/buscar_mangas/?page=${page}&page_size=50`;

            try {
                const res = await axios.get(url, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0',
                        'Accept': 'application/json, text/javascript, */*; q=0.01',
                        'Accept-Language': 'es-ES,es;q=0.8,en-US;q=0.5,en;q=0.3',
                        'X-Requested-With': 'XMLHttpRequest',
                        'Referer': refererUrl,
                        'Sec-Fetch-Dest': 'empty',
                        'Sec-Fetch-Mode': 'cors',
                        'Sec-Fetch-Site': 'same-origin'
                    },
                    timeout: 25000
                });

                if (res.data) {
                    const filename = path.join(outfolder, `${page}.json`);
                    let jsondata;
                    if (typeof res.data === 'string') {
                        jsondata = res.data
                    } else {
                        jsondata = JSON.stringify(res.data, null, 2)
                    }

                    fs.writeFileSync(filename, jsondata, 'utf-8');
                    console.log(`[SAVED] Pág ${page} -> saved`);
                }

            } catch (error) {
                console.error(`[FAIL] Pág ${page} -> Error: ${error.message}`);
            }
        });

        await Promise.all(promBatch);
    }

    // Una vez terminadas las descargas, ejecutamos el parser
    console.log("\n[PROCESS] Iniciando parseo y consolidación de archivos...");
    await parser();
}

async function parser() {
    try {
        // 1. Leer todos los archivos que están dentro de la carpeta temporal 'esp'
        const files = fs.readdirSync(outfolder);
        const listaMangasFinal = [];

        for (const file of files) {
            // Solo procesar si es un archivo .json
            if (path.extname(file) === '.json') {
                const filePath = path.join(outfolder, file);
                const fileContent = fs.readFileSync(filePath, 'utf-8');

                // Parseamos el contenido del archivo a Objeto JavaScript
                const parsedContent = JSON.parse(fileContent);

                // Validamos que tenga la propiedad 'resultados' y sea un array
                if (parsedContent && Array.isArray(parsedContent.resultados)) {
                    parsedContent.resultados.forEach(manga => {
                        // Mapeamos los datos exactamente al formato que solicitaste
                        listaMangasFinal.push({
                            "slug": manga.slug,
                            "title": manga.titulo,
                            "type": manga.tipo,
                            "url": `https://mangalect.org/info/${manga.slug}`,
                            "image": `https://images.mangalect.org/file/leermangaesp/${manga.portada}`
                        });
                    });
                }
            }
        }

        // 2. Guardar el archivo JSON gigante definitivo en la raíz del script
        //const outputFile = path.join(__dirname, '..', '..', '..', 'data', 'esp.json');
        const outputFile = path.join(__dirname, 'tmp', 'esp.json');

        fs.writeFileSync(outputFile, JSON.stringify(listaMangasFinal, null, 2), 'utf-8');
        console.log(`[SUCCESS] Archivo final guardado en: ${outputFile} (Total mangas: ${listaMangasFinal.length})`);

        // 3. Destruir la carpeta temporal 'esp' y su contenido
        console.log("[PROCESS] Eliminando carpeta temporal 'esp'...");
        fs.rmSync(outfolder, { recursive: true, force: true });
        console.log("[SUCCESS] Carpeta 'esp' eliminada correctamente.");

    } catch (error) {
        console.error(`[ERROR PARSER] Hubo un problema al procesar los archivos: ${error.message}`);
    }
}
if (process.send) {
    const meterInterval = setInterval(() => {
        process.send({
            type: 'RAM_TICK',
            rss: process.memoryUsage().rss
        });
    }, 50);

    // Esto evita que el setInterval mantenga el script colgado al terminar
    meterInterval.unref();
}
if (global.gc) {
    global.gc();
}
// Iniciar todo el flujo
downloadData();