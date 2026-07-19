// extractor
const cheerio = require('cheerio');
const { axiosGet } = require('../../helpersCore');

async function getTmo(url) {
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
    $('.reader-img-wrap img.reader-image').each((index, element) => {
        const imgSrc = $(element).attr('src');
        if (imgSrc) {
            imgs.push(imgSrc);
        }
    });

    return imgs;
}
module.exports = { getTmo }