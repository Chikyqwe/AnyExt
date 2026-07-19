// extractor
const cheerio = require('cheerio');
const { axiosGet } = require('../../helpersCore');

async function getesp(url) {
    let html = (await axiosGet(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0',
            'Accept': '*/*',
            'Referer': url
        }
    })).data;

    const $ = cheerio.load(html);
    const imgs = [];

    // Selecciona todas las imágenes dentro de los contenedores de las páginas
    $('script').each((index, element) => {
        const scriptContent = $(element).html();
        if (scriptContent && scriptContent.includes('const Config = {')) {
            try {
                // Expresión regular para capturar la URL base (B2_URL)
                const b2UrlMatch = scriptContent.match(/B2_URL:\s*["']([^"']+)["']/);

                // Expresión regular para capturar el array de rutas (paginasRutas)
                const paginasRutasMatch = scriptContent.match(/paginasRutas:\s*(\[[^\]]+\])/);

                if (b2UrlMatch && paginasRutasMatch) {
                    const b2Url = b2UrlMatch[1]; // Ex: "https://images.leermangaesp.net/file/leermangaesp"

                    // Convertimos el string del array que capturó regex en un array real de JavaScript
                    // Usamos JSON.parse reemplazando comillas simples por dobles por seguridad si fuera necesario
                    const validJsonArray = paginasRutasMatch[1].replace(/'/g, '"');
                    const paginasRutas = JSON.parse(validJsonArray);

                    // 3. Replicamos el mapeo de la propiedad 'pages' del Config original
                    paginasRutas.forEach(ruta => {
                        imgs.push(`${b2Url}/${ruta}`);
                    });
                }
            } catch (error) {
                console.error("Error al procesar el script de configuración:", error.message);
            }
        }
    })
    return imgs;
}

module.exports = { getesp }