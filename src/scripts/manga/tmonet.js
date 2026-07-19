const axios = require('axios');
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const fsSync = require('fs');


const outfolder = path.join(__dirname, 'tmo');

if (!fs.existsSync(outfolder)) {
    fs.mkdirSync(outfolder);
}
async function getpags() {
    const res = await axios.get("https://zonatmo.net/wp-api/api/listing/manga?page=1&postsPerPage=30&orderBy=ID&order=desc", {
        headers: {
            'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0',
            'Accept': 'application/json, text/javascript, */*; q=0.01',
            'Accept-Language': 'es-ES,es;q=0.8,en-US;q=0.5,en;q=0.3',
            'X-Requested-With': 'XMLHttpRequest',
            'Referer': "https://olympusxyz.com/api/series?page=1&direction=asc&type=comic",
            'Sec-Fetch-Dest': 'empty',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Site': 'same-origin'
        },
        timeout: 25000
    });
    const data = res.data;
    const lastp = data.data.pagination.total_pages;
    return lastp;
}
async function downloadData() {
    const paginit = 1;
    const pagend = await getpags();
    const batch_size = 50;
    const pag = [];
    for (let i = paginit; i <= pagend; i++) {
        pag.push(i);
    }

    for (let i = 0; i < pag.length; i += batch_size) {
        const batchCurrent = pag.slice(i, i + batch_size);

        const promBatch = batchCurrent.map(async (page) => {
            const url = `https://zonatmo.net/wp-api/api/listing/manga?page=${page}&postsPerPage=30&orderBy=ID&order=desc`;
            const refererUrl = `https://zonatmo.net/wp-api/api/listing/manga?page=${page - 1}&postsPerPage=30&orderBy=ID&order=desc`;

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
    console.log("\n[PROCESS] Iniciando parseo y consolidación de archivos...");
    await parser();
}

async function parser() {
    try {
        console.log("\n[PROCESS] Iniciando parseo y consolidación de archivos...");

        // Leemos el directorio de forma asíncrona
        const files = await fsp.readdir(outfolder);
        const listaMangasFinal = [];

        for (const file of files) {
            if (path.extname(file) === '.json') {
                const filePath = path.join(outfolder, file);

                // Lectura asíncrona para liberar el event loop
                const fileContent = await fsp.readFile(filePath, 'utf-8');
                const parsedContent = JSON.parse(fileContent);

                // Validamos que el JSON tenga la estructura esperada de la API
                if (parsedContent && parsedContent.data && Array.isArray(parsedContent.data.items)) {

                    // Recorremos los items del JSON directamente, sin Cheerio
                    for (const item of parsedContent.data.items) {

                        // Adaptamos los datos de la API a tu estructura final
                        listaMangasFinal.push({
                            "slug": item.slug || '',
                            "title": item.title || '',
                            "type": String(item._type || ''),
                            "url": `https://zonatmo.net/manga/${item.slug}`,
                            "image": "https://zonatmo.net/wp-content/uploads" + item.cover || ''
                        });
                    }
                }
            }
        }

        // Guardar el archivo consolidado de forma asíncrona
        const outputFile = path.join(__dirname, 'tmp', 'tmonet.json');
        await fsp.writeFile(outputFile, JSON.stringify(listaMangasFinal, null, 2), 'utf-8');
        console.log(`[SUCCESS] Archivo final guardado en: ${outputFile} (Total mangas: ${listaMangasFinal.length})`);

        // Destruir la carpeta temporal
        console.log("[PROCESS] Eliminando carpeta temporal...");
        fsSync.rmSync(outfolder, { recursive: true, force: true });
        console.log("[SUCCESS] Carpeta eliminada correctamente.");

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
downloadData();  