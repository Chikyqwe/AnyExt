const express = require('express');
const path = require('path');
const fs = require('fs');
const router = express.Router();
const { getAnimeByUnitId } = require('../services/jsonService');
const imgs = require('../controllers/imageController');

const axios = require('axios');
const STATIC_SERVER_URL = process.env.STATIC_SERVER_URL;

async function getHtmlContent(filename, l) {
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

// -------------------- HELPERS --------------------
async function sendHtml(res, filename, l) {
  const { content, status } = await getHtmlContent(filename, l);
  res.setHeader('Content-Type', 'text/html');
  res.status(status).send(content);
}

// -------------------- RUTAS --------------------

// Raíz
router.get('/', async (req, res) => {
  await sendHtml(res, 'index.html');
});

// Screenshots / Images
router.get('/app/screenshots', imgs.listImages);
router.get('/app/images/:imageName', imgs.serveImage);

// Player y App
// Player con meta tags dinámicos
router.get('/player/:id/:ep', async (req, res) => {
  try {
    const { id, ep } = req.params;
    // Buscamos los datos del anime usando el ID de los parámetros de la URL
    const animeData = await getAnimeByUnitId(id);

    // Configuramos las variables para los meta tags (puedes incluir el episodio en el título si gustas)
    const title = animeData ? `${animeData.title} - Episodio ${ep}` : 'Ver Anime Online';
    const desc = animeData ? `Disfruta del episodio ${ep} de ${animeData.title} en HD.` : 'Disfruta de los mejores animes online';
    const image = animeData?.image || '';
    const url = `${req.protocol}://${req.get('host')}${req.originalUrl}`;

    // Construimos los meta tags dinámicos
    const metaTags = `
      <meta property="og:title" content="${title}">
      <meta property="og:description" content="${desc}">
      <meta property="og:image" content="${image}">
      <meta property="og:url" content="${url}">
      <meta name="twitter:card" content="summary_large_image">  
      <meta property="og:image:width" content="1200">
      <meta property="og:image:height" content="630">
    `;

    const { content: baseHtml, status } = await getHtmlContent('player.html');
    const html = baseHtml.replace('</head>', `${metaTags}\n</head>`);

    res.setHeader('Content-Type', 'text/html');
    res.status(status).send(html);
  } catch (err) {
    console.error('[ERROR] /player/:id/:ep:', err.message);
    // Si algo falla, como fallback podemos enviar el HTML limpio sin meta tags para no romper la app
    await sendHtml(res, 'player.html');
  }
});

router.get("/reader/test", async (req, res) => {
  await sendHtml(res, 'Treader.html', true);
});

router.get('/app', async (req, res) => await sendHtml(res, 'app.html'));
// Privacy policy
router.get('/privacy-policy.html', async (req, res) => await sendHtml(res, 'privacy-policy.html'));

// App share con meta tags dinámicos
router.get('/app/share', async (req, res) => {
  try {
    const animeData = await getAnimeByUnitId(req.query.uid);

    const title = animeData?.title || 'Anime EXT';
    const desc = 'Disfruta de los mejores animes online';
    const image = animeData?.image || '';
    const url = `${req.protocol}://${req.get('host')}${req.originalUrl}`;

    const metaTags = `
      <meta property="og:title" content="${title}">
      <meta property="og:description" content="${desc}">
      <meta property="og:image" content="${image}">
      <meta property="og:url" content="${url}">
      <meta name="twitter:card" content="summary">  
      <meta property="og:image:width" content="260">
      <meta property="og:image:height" content="370">
    `;

    const { content: baseHtml, status } = await getHtmlContent('app_redir.html');
    const html = baseHtml.replace('</head>', `${metaTags}\n</head>`);

    res.setHeader('Content-Type', 'text/html');
    res.status(status).send(html);
  } catch (err) {
    console.error('[ERROR] /app/share:', err.message);
    res.status(500).send('Error interno');
  }
});

module.exports = router;
