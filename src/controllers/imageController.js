const fs = require('fs').promises;
const asyncHandler = require('../middlewares/asyncHandler');
const { proxyImage } = require('../utils/helpers');
const path = require('path');
// 1. Importar el servicio que faltaba
const { getAnimeByUnitId } = require('../services/jsonService');

// GET /image
exports.imageProxy = asyncHandler(async (req, res) => {
  const { url } = req.query;
  await proxyImage(url, res);
});

exports.listImages = asyncHandler(async (req, res) => {
  const imagesDir = path.join(__dirname, '..', '..', 'public', 'img', 'app');
  const files = await fs.readdir(imagesDir);
  const images = files.filter(file => /\.(jpg|jpeg|png|gif)$/i.test(file));
  res.json(images);
});

exports.serveImage = asyncHandler(async (req, res) => {
  const { imageName } = req.params;
  const imagesDir = path.join(__dirname, '..', '..', 'public', 'img', 'app');
  const imagePath = path.join(imagesDir, imageName);
  await fs.access(imagePath); // lanzará error si no existe
  res.sendFile(imagePath);
});

// 2. Envolver con asyncHandler por seguridad si proxyImage es asíncrona
exports.rokuimg = asyncHandler(async (req, res) => {
  const { uid } = req.query;
  const anime = await getAnimeByUnitId(parseInt(uid)); // Si getAnimeByUnitId es async, usa await

  if (!anime) {
    return res.status(404).json({ error: `Anime uid=${uid} no encontrado` });
  }

  const imageUrl = anime.image || anime.cover;
  if (!imageUrl) {
    return res.status(404).json({ error: 'Sin imagen' });
  }

  return await proxyImage(imageUrl, res);
});