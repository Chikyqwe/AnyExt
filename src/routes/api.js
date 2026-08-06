const express = require('express');
const router = express.Router();

const anime = require('../controllers/animeController');
const media = require('../controllers/mediaController');
const image = require('../controllers/imageController');
const views = require('../controllers/viewController');

router.post('/api/play', media.play);
router.get('/api/getMedia/:p', media.getMedia);
router.get('/api/stream', media.stream);
router.get('/api/req', media.reqProxy);
router.get('/api/req/post', views.reqPostProxy);
router.get('/api/hls', media.proxy);
router.get('/api/queue', media.queueStatus);
router.get('/app/v', media.appV);
router.get('/api/download', media.download);

router.get('/api/info', media.info);
router.get('/api/list', media.list);
router.post('/api/search', media.search);
router.post('/api/rebuildSearch', media.rebuildSearch);

router.get('/anime/last', anime.last);
router.post('/api/img', media.img);
router.get('/api/roku/img', image.rokuimg);
router.get('/api', views.initmjs);
router.get('/api/basic/info', media.basicInfo);

router.get('/image', image.imageProxy);
router.get('/images/app', image.listImages);
router.get('/images/app/:imageName', image.serveImage);

module.exports = router;