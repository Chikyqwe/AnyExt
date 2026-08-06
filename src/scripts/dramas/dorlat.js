const axios = require('axios');
const cheerio = require('cheerio');
const fs = require("fs")
const path = require("path")

const outfolder = path.join(__dirname, 'tmp');

if (!fs.existsSync(outfolder)) fs.mkdirSync(outfolder);

const client = axios.create({
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
    },
    timeout: 10000
});

async function obtenerDoramasPorPagina(pagina) {
    const url = `https://doramaslat.com/tvshows/page/${pagina}/`;

    try {
        const response = await client.get(url);
        const $ = cheerio.load(response.data);
        const resultados = [];

        $('article.post, .items .item').each((i, el) => {
            const $item = $(el);

            const title = $item.find('.data h3 a, .title a, h3 a').text().trim();
            const doramaUrl = $item.find('.data h3 a, .title a, .poster a').attr('href') || '';
            const image = $item.find('.poster img').attr('src')
                || $item.find('.poster img').attr('data-src')
                || '';

            const slug = doramaUrl.replace(/\/$/, '').split('/').pop() || '';
            const type = $item.find('.quality, .type').text().trim() || 'TV';

            if (title && doramaUrl) {
                resultados.push({ slug, title, type, url: doramaUrl, image });
            }
        });

        return { pagina, data: resultados, estado: 'success' };

    } catch (error) {
        if (error.response && error.response.status === 404) {
            return { pagina, data: [], estado: '404' };
        }
        console.error(`[fail] Error en la pagina ${pagina}: ${error.message}`);
        return { pagina, data: [], estado: 'fail' };
    }
}

async function scrapingPorBatches(totalPaginas = 16, tamañoBatch = 5) {
    let todosLosDoramas = [];
    const urlsProcesadas = new Set();
    let hayMasPaginas = true;

    console.log(`[info] Iniciando extraccion: ${totalPaginas} paginas en lotes de ${tamañoBatch}`);

    for (let i = 1; i <= totalPaginas && hayMasPaginas; i += tamañoBatch) {
        const lotePromesas = [];
        for (let j = i; j < i + tamañoBatch && j <= totalPaginas; j++) {
            lotePromesas.push(obtenerDoramasPorPagina(j));
        }

        console.log(`[info] Procesando lote: paginas del ${i} al ${Math.min(i + tamañoBatch - 1, totalPaginas)}`);

        const resultadosLote = await Promise.all(lotePromesas);

        for (const res of resultadosLote) {
            if (res.estado === '404') {
                console.log(`[info] Se llego al final (404) en la pagina ${res.pagina}. Deteniendo scraper.`);
                hayMasPaginas = false;
                break;
            }

            if (res.estado === 'success') {
                let agregadosNuevos = 0;

                for (const dorama of res.data) {
                    // Validar si la URL ya existe en el registro global
                    if (!urlsProcesadas.has(dorama.url)) {
                        urlsProcesadas.add(dorama.url);
                        todosLosDoramas.push(dorama);
                        agregadosNuevos++;
                    }
                }

                console.log(`[success] Pagina ${res.pagina} procesada (${agregadosNuevos} elementos nuevos)`);
            }
        }
    }

    console.log(`[info] Proceso finalizado. Total de doramas unicos obtenidos: ${todosLosDoramas.length}`);

    if (!fs.existsSync(outfolder)) {
        fs.mkdirSync(outfolder, { recursive: true });
    }
    const outfile = path.join(outfolder, "dorlat.json")
    fs.writeFileSync(outfile, JSON.stringify(todosLosDoramas, null, 2));
    console.log('[info] Resultados guardados exitosamente en ./tmp/doramas.json');
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

// Ejecutar para 16 páginas en batches de 5
scrapingPorBatches(16, 5);