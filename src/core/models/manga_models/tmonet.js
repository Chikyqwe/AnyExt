//extractor
const { axiosGet } = require('../../helpersCore');

async function getTmonet(url) {
    let furl = "https://zonatmo.net/wp-api/api/single" + (new URL(url)).pathname
    let dat = (await axiosGet(furl, {
        headers: {
            'User-Agent': 'Mozilla/5.0',
            'Accept': '*/*',
            'Referer': furl
        }
    })).data;
    const data = JSON.parse(dat)
    const imgs = [];
    if (data && data.data && data.data.chapter && data.data.chapter.images) {
        const burl = "https://cdn.zonatmo.to/manga/" + data.data.chapter.jit + "/";
        data.data.chapter.images.forEach(img => {
            const Iurl = burl + img.image_url;
            imgs.push(Iurl);
        });
    }

    return imgs;
}

module.exports = { getTmonet }