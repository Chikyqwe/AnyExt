const path = require('path');
const fs = require('fs');
const axios = require('axios');
const STATIC_SERVER_URL = process.env.STATIC_SERVER_URL;

async function getFile(filename, l) {
    let content = '';
    let status = 200;

    if (STATIC_SERVER_URL && !l) {
        try {
            const response = await axios.get(`${STATIC_SERVER_URL}/${filename}`);
            content = response.data;
        } catch (err) {
            console.warn(`[FETCH] No se pudo cargar ${filename} desde remoto: ${err.message}`);
            const fullPath = path.join(__dirname, '..', '..', 'public', 'index.html'); // fallback a index.html que tiene el 503
            try {
                content = fs.readFileSync(fullPath, 'utf8');
            } catch (e) {
                content = '503 Service Unavailable';
            }
            status = 503;
        }
    } else {
        const fullPath = path.join(__dirname, '..', '..', 'public', filename);
        try {
            content = fs.readFileSync(fullPath, 'utf8');
        } catch (err) {
            console.warn(`[FETCH] No se pudo cargar ${filename}: ${err.message}`);
            content = '';
            status = 404;
        }
    }

    return { content, status };
}

module.exports = { getFile }