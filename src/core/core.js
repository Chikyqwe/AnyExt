'use strict';

const axios = require('axios');
const cheerio = require('cheerio');
const { URL } = require('url');
const crypto = require('crypto');
const { TextCache } = require('./cache/cache');
const linksCache = new TextCache({ ttlMs: 10 * 60 * 1000 });

// ================== AXIOS ==================
const UA_FIREFOX =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0';

const axiosInstance = axios.create({
  timeout: 10000,
  headers: {
    'User-Agent': UA_FIREFOX,
    'Accept-Encoding': 'gzip, deflate, br'
  }
});

async function axiosGet(url, opts = {}) {
  const controller = new AbortController();
  const timeout = opts.timeout ?? 10000;
  const t = setTimeout(() => controller.abort(), timeout + 100);

  try {
    return await axiosInstance.get(url, {
      ...opts,
      signal: controller.signal
    });
  } finally {
    clearTimeout(t);
  }
}

// ================== IMPORT EXTRACTORS DE PORTALES ==================
// Importamos los extractores de las páginas web (asumiendo que están en tu carpeta de modelos o portales)
const hl = require('./models/basic_models/hl');       // hentaila
const aniyae = require('./models/basic_models/ay'); // open.aniyae
const one = require('./models/basic_models/one');       // animeflv.one
const jk = require('./models/basic_models/jk');         // jkanime
const generic = require('./models/basic_models/generic'); // genérico

// Mapa de portales usando Expresiones Regulares para emparejar la URL
const portalExtractors = [
  { regex: /hentaila\.com/i, module: hl },
  { regex: /open\.aniyae\.net/i, module: aniyae },
  { regex: /animeflv\.one/i, module: one },
  { regex: /jkanime\.net/i, module: jk }
];

// Helper para normalizar la función de extracción del portal
function getPortalExtractorFn(mod) {
  if (typeof mod === 'function') return mod;
  if (typeof mod?.extractGeneric === 'function') return mod.extractGeneric;
  if (typeof mod?.extractHL === 'function') return mod.extractHL;
  if (typeof mod?.extractAniyae === 'function') return mod.extractAniyae;
  if (typeof mod?.extractONE === 'function') return mod.extractONE;
  if (typeof mod?.extractJK === 'function') return mod.extractJK;
  return null;
}

// ------------------------------
// MAIN
// ------------------------------
async function extractAllVideoLinks(pageUrl) {
  const pageKey = crypto.createHash('md5').update(pageUrl).digest('hex');

  // Cache
  if (linksCache.exists(pageKey)) {
    try {
      return JSON.parse(linksCache.load(pageKey));
    } catch {
      console.error("[CACHE-LINKS] Error parseando caché, re-extrayendo...");
    }
  }

  let html;
  try {
    const res = await axiosGet(pageUrl, { timeout: 8000 });
    html = res.data;
  } catch (e) {
    console.error('[EXTRACTOR] Error descargando página:', e.message);
    return { status: 700, mjs: e.message };
  }

  const $ = cheerio.load(html);
  let videos = [];
  
  // --- NUEVA LÓGICA DINÁMICA BASADA EN REQUIRES ---
  // Buscamos si la URL coincide con alguno de nuestros extractores registrados
  const match = portalExtractors.find(p => p.regex.test(pageUrl));
  let extractFn = match ? getPortalExtractorFn(match.module) : null;

  if (extractFn) {
    videos = await extractFn($, pageUrl);
  } else {
    // Si no coincide con ninguno, usamos el genérico (también requerido desde módulo)
    const genericFn = getPortalExtractorFn(generic);
    videos = genericFn ? await genericFn($, pageUrl) : [];
  }
  // -------------------------------------------------

  // Guardar cache
  if (videos.length > 0) {
    linksCache.save(pageKey, JSON.stringify(videos));
  }

  return videos;
}

// ================== IMPORT EXTRACTORS DE SERVIDORES ==================
const sw = require('./models/sw');
const voe = require('./models/voe');
const bc = require('./models/bc');
const yu = require('./models/yu');
const st = require('./models/st');
const uq = require('./models/uq');
const mp4 = require('./models/mp4');
const jkum = require('./models/jkum');

// ================== NORMALIZER ==================
function normalizeExtractor(mod) {
  if (typeof mod === 'function') return mod;
  if (typeof mod?.extract === 'function') return mod.extract;
  if (typeof mod?.extractST === 'function') return mod.extractST;
  if (typeof mod?.extractVoe === 'function') return mod.extractVoe;
  if (typeof mod?.extractM3u8 === 'function') return mod.extractM3u8;
  if (typeof mod?.uq === 'function') return mod.uq;
  if (typeof mod?.mp4 === 'function') return mod.mp4;
  if (typeof mod?.jkum === 'function') return mod.jkum;
  throw new Error('Extractor inválido');
}

// ================== ROUTER ==================
const extractorMap = {
  streamwish: sw,
  swiftplayers: sw,
  obeywish: sw,
  sw: sw,
  voe: voe,
  burstcloud: bc,
  bc: bc,
  yourupload: yu,
  yu: yu,
  stape: st,
  uqload: uq,
  mp4upload: mp4,
  jkum: jkum,
};

function getExtractor(name) {
  const mod = extractorMap[name?.toLowerCase()];
  if (!mod) return null;
  const fn = normalizeExtractor(mod);
  return async function wrappedExtractor(url) {
    return await fn(url);
  };
}

module.exports = {
  axiosGet,
  cheerio,
  extractAllVideoLinks,
  getExtractor
};