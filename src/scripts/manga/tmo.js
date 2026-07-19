const axios = require('axios');
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const cheerio = require('cheerio');

const outfolder = path.join(__dirname, 'tmo');
const tmpFolder = path.join(__dirname, 'tmp');

if (!fs.existsSync(outfolder)) fs.mkdirSync(outfolder);
if (!fs.existsSync(tmpFolder)) fs.mkdirSync(tmpFolder);

async function downloadData() {
    const paginit = 1;
    const pagend = 1292;
    const batch_size = 50;
    const pag = [];
    for (let i = paginit; i <= pagend; i++) pag.push(i);

    for (let i = 0; i < pag.length; i += batch_size) {
        const batchCurrent = pag.slice(i, i + batch_size);

        const promBatch = batchCurrent.map(async (page) => {
            const url = `https://zonatmo.org/biblioteca?order_item=likes_count&order_dir=desc&title=&_pg=1&filter_by=title&author_filter=&type=&demography=&status=&page=${page}`;
            const refererUrl = `https://zonatmo.org/biblioteca?order_item=likes_count&order_dir=desc&title=&_pg=1&filter_by=title&author_filter=&type=&demography=&status=&page=${page - 1}`;

            try {
                const res = await axios.get(url, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0',
                        'Accept': 'application/json, text/javascript, */*; q=0.01',
                        'X-Requested-With': 'XMLHttpRequest',
                        'Referer': refererUrl
                    },
                    timeout: 25000
                });

                if (res.data) {
                    const filename = path.join(outfolder, `${page}.json`);
                    let jsondata = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
                    await fsp.writeFile(filename, jsondata, 'utf-8');
                    console.log(`[SAVED] Pág ${page} -> saved`);
                }
            } catch (error) {
                console.error(`[FAIL] Pág ${page} -> Error: ${error.message}`);
            }
        });

        await Promise.all(promBatch);
    }
    await parser();
}

async function parser() {
    try {
        console.log("\n[PROCESS] Iniciando parseo y consolidación optimizada...");

        const files = await fsp.readdir(outfolder);
        const jsonFiles = files.filter(file => path.extname(file) === '.json');

        const outputFile = path.join(tmpFolder, 'tmo.json');

        // OPTIMIZACIÓN 1: Usar un WriteStream nativo para escribir directo al disco sin usar memoria RAM
        const writeStream = fs.createWriteStream(outputFile, { encoding: 'utf-8' });
        writeStream.write('[\n'); // Iniciamos el array JSON manualmente

        let isFirstItem = true;
        let totalMangas = 0;

        for (const file of jsonFiles) {
            const filePath = path.join(outfolder, file);
            const fileContent = await fsp.readFile(filePath, 'utf-8');
            const parsedContent = JSON.parse(fileContent);

            if (parsedContent && parsedContent.html) {
                // OPTIMIZACIÓN 2: Configuración ultra-ligera para Cheerio
                const $ = cheerio.load(parsedContent.html, { xml: false, lowerCaseTags: true });

                $('.element').each((index, element) => {
                    const linkEl = $(element).find('a');
                    const imgEl = $(element).find('img.cover-bg-img');
                    const titleEl = $(element).find('.thumbnail-title h4');
                    const typeEl = $(element).find('.book-type');

                    const urlCompleta = linkEl.attr('href') || '';
                    const slug = urlCompleta.split('/').pop() || '';

                    const mangaObj = {
                        "slug": slug,
                        "title": titleEl.attr('title') || titleEl.text().trim(),
                        "type": typeEl.text().trim(),
                        "url": urlCompleta,
                        "image": imgEl.attr('src') || ''
                    };

                    // Escribimos directo al stream y agregamos comas correctamente
                    if (!isFirstItem) {
                        writeStream.write(',\n');
                    } else {
                        isFirstItem = false;
                    }

                    writeStream.write(JSON.stringify(mangaObj, null, 2));
                    totalMangas++;
                });

                // OPTIMIZACIÓN 3: Destrucción absoluta de Cheerio en cada iteración del bucle
                $._root = null;
                if (global.gc) {
                    global.gc();
                }
            }

            // OPTIMIZACIÓN 4: Forzar limpieza de microtareas cada 50 archivos para dar un respiro a la RAM
            if (totalMangas % 1000 === 0) {
                await new Promise(resolve => setImmediate(resolve));
            }
        }

        writeStream.write('\n]'); // Cerramos el array JSON
        writeStream.end();

        console.log(`[SUCCESS] Archivo final guardado en: ${outputFile} (Total mangas: ${totalMangas})`);

        console.log("[PROCESS] Eliminando carpeta temporal...");
        fs.rmSync(outfolder, { recursive: true, force: true });
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
    meterInterval.unref();
}
if (global.gc) {
    global.gc();
}
downloadData();