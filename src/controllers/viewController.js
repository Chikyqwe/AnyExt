const path = require('path');
const fs = require('fs');
const axios = require('axios');
const asyncHandler = require('../middlewares/asyncHandler');
const STATIC_SERVER_URL = process.env.STATIC_SERVER_URL;

exports.getFile = async (filename, l) => {
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
};
exports.initmjs = asyncHandler(async (req, res) => {
    res.json({
        mjs: 'This is the AnyExt API, please return to the main page.',
        web: 'https://anyext.qzz.io/',
        date: new Date().toISOString()
    });
});

exports.reqPostProxy = asyncHandler(async (req, res) => {
    const targetUrlStr = req.query.u;

    if (!targetUrlStr) {
        return res.status(400).json({ error: true, message: 'Parámetro "u" obligatorio' });
    }

    try {
        const targetUrl = new URL(targetUrlStr);

        // Extraemos todos los parametros de la query URL y los convertimos en objeto Body
        const bodyData = {};
        targetUrl.searchParams.forEach((value, key) => {
            bodyData[key] = value;
        });

        // La URL limpia sin querystring
        const cleanUrl = `${targetUrl.origin}${targetUrl.pathname}`;

        // Hacemos la petición POST interna con los parámetros extraídos
        const response = await fetch(cleanUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(bodyData)
        });

        const data = await response.json();
        return res.status(response.status).json(data);

    } catch (e) {
        return res.status(400).json({ error: true, message: 'URL inválida o error en reenvío', details: e.message });
    }
});
