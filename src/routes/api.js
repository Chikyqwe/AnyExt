// src/routes/index.js  — ejemplo de router Express adaptado a plan.rest
// ============================================================

const express = require('express');
const router = express.Router();

const video = require('../controllers/videoController');
const anime = require('../controllers/animeController');
const manga = require('../controllers/mangaController');
const content = require('../controllers/contentController');
const image = require('../controllers/imageController');
const asyncHandler = require('../middlewares/asyncHandler');

// ──────────────────────────────────────────────
//  VIDEO / STREAM
// ──────────────────────────────────────────────

// POST /api/play  ← NUEVO (fusiona /api/servers + /api/video)
router.post('/api/play', video.play);

// GET  /api/getMedia/:p  ← NUEVO (renombra /api/get/hls/:uuid)
router.get('/api/getMedia/:p', video.getMedia);

// GET  /api/stream?gid=  ← renombrado desde ?videoUrl= (retrocompat mantenida)
router.get('/api/stream', video.stream);

// GET  /api/req?u=&h=  ← renombrado desde /api/req?url= , agrega header support
router.get('/api/req', video.reqProxy);

// GET  /api/proxy?url=&ref=  ← renombrado desde /api/hlsProxy
router.get('/api/hls', video.proxy);

// GET  /api/queue
router.get('/api/queue', video.queueStatus);

// GET  /app/v
router.get('/app/v', video.appV);

// GET  /api/download
router.get('/api/download', video.download);

// ──────────────────────────────────────────────
//  CONTENT (ANIME & MANGA)
// ──────────────────────────────────────────────

// GET  /api/info?uid=  ← (unifica anime y manga)
router.get('/api/info', content.info);

// GET  /api/list?p=  ← (unifica anime y manga con paginación)
router.get('/api/list', content.list);

// POST /api/search  ← (unifica búsquedas)
router.post('/api/search', content.search);

// POST /api/rebuildSearch
router.post('/api/rebuildSearch', content.rebuildSearch);

// ──────────────────────────────────────────────
//  ANIME (Legacy or specific)
// ──────────────────────────────────────────────

// GET  /anime/last
router.get('/anime/last', anime.last);

// POST /api/img  ← (cover + ep thumbnail para anime y manga)
router.post('/api/img', content.img);

router.get('/anime/roku/img', anime.rokuimg);

router.get('/api', anime.initmjs)

router.get('/api/basic/info', anime.basicInfo)

// ──────────────────────────────────────────────
//  IMAGES
// ──────────────────────────────────────────────


// GET  /image?url=
router.get('/image', image.imageProxy);

// GET  /images/app/
router.get('/images/app', image.listImages);
router.get('/images/app/:imageName', image.serveImage);

// dev
const fs = require('fs');
const path = require('path');
const { getHeapSnapshot } = require('v8');

router.get('/dev/snapshot', asyncHandler(async (req, res) => {
  console.log("[INFO] DUMPING HEAP SNAPSHOT at", Date.now(), "FROM", req.ip);
  const filename = `snapshot-${Date.now()}.heapsnapshot`;
  const filepath = path.join(process.cwd(), filename);

  const snapshotStream = getHeapSnapshot();
  const fileStream = fs.createWriteStream(filepath);
  snapshotStream.pipe(fileStream);

  fileStream.on('finish', () => {
    res.download(filepath, filename, (err) => {
      fs.unlink(filepath, () => { }); // Borrar después de enviar
      if (err) console.error('Error enviando snapshot:', err);
    });
  });
}));
router.get('/dev/cache/dump', asyncHandler(async (req, res) => {
  console.log("[INFO] DUMPING CACHE at", Date.now(), "FROM", req.ip);
  const data = dumpAllCache();

  res.json({
    ok: true,
    total: Object.keys(data).length,
    cache: data
  });
}));


module.exports = router;
