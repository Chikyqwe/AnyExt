// extractor
const cheerio = require('cheerio');
const { axiosGet } = require('../../helpersCore');

async function getoly(url) {
    try {
        let html = (await axiosGet(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Referer': url
            }
        })).data;

        // Cargamos Cheerio en modo ultra-ligero para no saturar la RAM
        const $ = cheerio.load(html, { xml: false, lowerCaseTags: true });
        const imgs = [];

        // Buscamos las imágenes dentro del contenedor principal <main chapter>
        $('main[chapter] section img').each((index, element) => {
            const imgSrc = $(element).attr('src');

            // Filtramos para evitar capturar logos o placeholders transparentes
            if (imgSrc && imgSrc.startsWith('http') && imgSrc.includes('/comics/')) {
                imgs.push(imgSrc);
            }
        });

        // OPTIMIZACIÓN CRÍTICA: Destruimos la instancia de Cheerio para liberar RAM de inmediato
        $._root = null;

        return imgs;

    } catch (error) {
        console.error(`[ERROR OLYMPUS] No se pudieron extraer las imágenes: ${error.message}`);
        return [];
    }
}

module.exports = { getoly }