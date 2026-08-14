// src/utils/helpers.js
// ============================================================================
// DEPENDENCIAS
// ============================================================================
const axios = require('axios');
const urlLib = require('url');
const cheerio = require('cheerio');
const vm = require('vm');
const { http, https } = require('follow-redirects');
const httpNative = require('http');
const httpsNative = require('https');
const genmap = require("./maps/map.json");
const { axiosGet } = require('../core/helpersCore');
const { getSR } = require('../core/models/basic_models/helpers/sr');
const { TextCache, KeyCache } = require('../core/cache/cache');

// ─────────────────────────────────────────────
// INICIALIZAR CACHÉS CENTRALIZADOS
// ─────────────────────────────────────────────
// Usar KeyCache para objetos (episodios y descripciones)
const episodesCache = new KeyCache({ ttlMs: 15 * 60 * 1000 });    // 15 min - GUARDA OBJETOS
const descriptionCache = new KeyCache({ ttlMs: 30 * 60 * 1000 }); // 30 min - GUARDA STRINGS
const patternCache = new KeyCache({ ttlMs: 60 * 60 * 1000 });     // 1 hora - GUARDA OBJETOS

// ============================================================================
// MÓDULO: HTTP / AXIOS
// ============================================================================
const HttpModule = (() => {
  const httpAgent = new httpNative.Agent({ keepAlive: true, maxSockets: 50 });
  const httpsAgent = new httpsNative.Agent({ keepAlive: true, maxSockets: 50 });

  const axiosInstance = axios.create({
    httpAgent,
    httpsAgent,
    timeout: 20000,
    headers: {
      'Accept-Encoding': 'gzip, deflate, br',
      'User-Agent': 'Mozilla/5.0'
    }
  });

  return { axiosInstance };
})();

// ============================================================================
// MÓDULO: REGEX + EVAL SEGURO
// ============================================================================
const ParseModule = (() => {
  const ANIME_INFO = /var\s+anime_info\s*=\s*(\[[^\]]+\])/;
  const EPISODES = /var\s+episodes\s*=\s*(\[[\s\S]*?\]);/;
  const safeEval = code => vm.runInNewContext(code, {}, { timeout: 100 });
  return { ANIME_INFO, EPISODES, safeEval };
})();

// ============================================================================
// MÓDULO: PATRONES (CACHE CENTRALIZADO)
// ============================================================================
// ============================================================================
// MÓDULO: PATRONES (CACHE CENTRALIZADO)
// ============================================================================
const PatternModule = (() => {
  async function getAnimeFLVPattern() {
    const cacheKey = 'animeflv_pattern';

    const cached = patternCache.load(cacheKey);
    if (cached) {
      // Reconstruir la función desde los datos guardados
      return {
        thumbnail: (id, ep) => `https://cdn.animeflv.net/screenshots/${id}/${ep}/th_3.jpg`
      };
    }

    // Generar nuevo patrón (solo datos, sin funciones)
    const patternData = {
      baseUrl: 'https://cdn.animeflv.net/screenshots'
    };

    patternCache.save(cacheKey, patternData);

    // Devolver con la función reconstruida
    return {
      thumbnail: (id, ep) => `https://cdn.animeflv.net/screenshots/${id}/${ep}/th_3.jpg`
    };
  }

  async function getTioPattern() {
    const cacheKey = 'tio_pattern';

    const cached = patternCache.load(cacheKey);
    if (cached) {
      // Reconstruir las funciones desde los datos guardados
      return {
        episode: (slug, ep) => `https://tioanime.com/ver/${slug}-${ep}`,
        thumbnail: id => `https://tioanime.com/uploads/thumbs/${id}.jpg`
      };
    }

    // Generar nuevo patrón (solo datos, sin funciones)
    const patternData = {
      baseUrl: 'https://tioanime.com'
    };

    patternCache.save(cacheKey, patternData);

    // Devolver con las funciones reconstruidas
    return {
      episode: (slug, ep) => `https://tioanime.com/ver/${slug}-${ep}`,
      thumbnail: id => `https://tioanime.com/uploads/thumbs/${id}.jpg`
    };
  }

  return { getAnimeFLVPattern, getTioPattern };
})();

// ============================================================================
// MÓDULO: STREAMING / PROXY
// ============================================================================
const StreamModule = (() => {
  function getRefererForHost(host) {
    if (!host) return 'https://www.mp4upload.com/';
    if (host.includes('burstcloud')) return 'https://burstcloud.co/';
    if (host.includes('vidcache')) return 'https://www.yourupload.com/';
    if (host.includes('mp4upload')) return 'https://www.mp4upload.com/';
    if (host.includes('ok')) return 'https://ok.ru';
    return 'https://ok.ru';
  }

  function validateVideoUrl(videoUrl, timeoutMs = 5000) {
    return new Promise((resolve) => {
      let redirects = 0;
      const maxRedirects = 5;
      let resolved = false;
      const logs = [];

      const pushLog = (type, data) => logs.push({ time: new Date().toISOString(), type, data });
      const finish = (data) => { if (resolved) return; resolved = true; resolve({ ...data, log: logs }); };

      const doRequest = (currentUrl, method = 'HEAD') => {
        pushLog('request', { url: currentUrl, method });
        const u = urlLib.parse(currentUrl);
        const isHttps = u.protocol === 'https:';
        const agent = isHttps
          ? new https.Agent({ keepAlive: true, servername: u.hostname, rejectUnauthorized: false })
          : undefined;

        const options = {
          method, hostname: u.hostname,
          port: u.port || (isHttps ? 443 : 80),
          path: (u.pathname || '/') + (u.search || ''),
          headers: {
            Referer: 'https://www.yourupload.com/',
            'User-Agent': 'Mozilla/5.0',
            ...(method === 'GET' ? { Range: 'bytes=0-1023' } : {})
          },
          agent, timeout: timeoutMs
        };

        const proto = isHttps ? https : http;
        const req = proto.request(options, (res) => {
          pushLog('response', { statusCode: res.statusCode, headers: res.headers });

          if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
            if (++redirects > maxRedirects) return finish({ ok: false, reason: 'too_many_redirects' });
            const nextUrl = urlLib.resolve(currentUrl, res.headers.location);
            return doRequest(nextUrl, method);
          }

          const contentType = res.headers['content-type'] || '';
          const contentLength = Number(res.headers['content-length'] || 0);
          const isVideo = contentType.startsWith('video/') || contentType.includes('octet-stream');

          let reason;
          if (![200, 206].includes(res.statusCode)) reason = 'bad_status_code';
          else if (!isVideo) reason = 'not_video_mime';
          else if (contentLength <= 0) reason = 'empty_or_unknown_size';
          else reason = 'ok';

          finish({ ok: reason === 'ok', statusCode: res.statusCode, contentType, contentLength, finalUrl: currentUrl, reason });
        });

        req.on('error', (err) => {
          pushLog('error', { method, message: err.message, code: err.code });
          if (method === 'HEAD') return doRequest(currentUrl, 'GET');
          finish({ ok: false, reason: 'request_error' });
        });

        req.on('timeout', () => {
          req.destroy();
          finish({ ok: false, reason: 'timeout' });
        });

        req.end();
      };

      doRequest(videoUrl);
    });
  }

  async function proxyImage(url, res) {
    const controller = new AbortController();
    try {
      const r = await HttpModule.axiosInstance.get(url, { responseType: 'stream', signal: controller.signal });
      res.setHeader('Content-Type', r.headers['content-type'] || 'image/jpeg');
      const stream = r.data;
      const cleanup = () => { controller.abort(); stream.destroy(); };
      res.on('close', cleanup);
      res.on('error', cleanup);
      stream.on('error', cleanup);
      stream.pipe(res);
    } catch {
      res.headersSent ? res.end() : res.status(500).end();
    }
  }

  function streamVideo(videoUrl, req, res) {
    if (!videoUrl) return res.status(400).send('Falta parámetro videoUrl');
    const referer = getRefererForHost(videoUrl);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges');

    const parsedUrl = urlLib.parse(videoUrl);
    const isHttps = parsedUrl.protocol === 'https:';
    const protocol = isHttps ? https : http;

    let byteOffset = 0;
    const rangeHeader = req.headers.range;
    if (rangeHeader) {
      const m = rangeHeader.match(/bytes=(\d+)-/);
      if (m) byteOffset = parseInt(m[1], 10);
    }

    let done = false;
    let retries = 0;
    const MAX_RETRIES = 3;
    const RETRY_BASE_MS = 800;

    function terminate(code, msg) {
      if (done) return;
      done = true;
      if (!res.headersSent) {
        res.status(code).send(msg ?? '');
      } else if (!res.writableEnded) {
        res.end();
      }
    }

    req.once('close', () => { done = true; });

    function connect(fromByte) {
      if (done) return;

      const reqHeaders = {
        'Referer': referer,
        'Origin': referer,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': '*/*',
        'Accept-Encoding': 'identity',
      };

      if (fromByte > 0) {
        reqHeaders['Range'] = `bytes=${fromByte}-`;
      }

      const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (isHttps ? 443 : 80),
        path: (parsedUrl.pathname || '/') + (parsedUrl.search || ''),
        method: 'GET',
        headers: reqHeaders,
        rejectUnauthorized: false,
      };

      const originReq = protocol.request(options, (originRes) => {
        if (done) { originRes.resume(); return; }

        retries = 0;

        if (originRes.statusCode >= 400) {
          console.error(`[streamVideo] Origen respondió con HTTP ${originRes.statusCode} para la URL: ${videoUrl}`);
          originRes.resume();
          return terminate(originRes.statusCode, 'Video no disponible o enlace expirado');
        }

        if (!res.headersSent) {
          const outHeaders = {
            'Content-Type': 'video/mp4',
            'Accept-Ranges': 'bytes',
            'Content-Disposition': 'inline',
          };
          if (originRes.headers['content-length'])
            outHeaders['Content-Length'] = originRes.headers['content-length'];
          if (originRes.headers['content-range'])
            outHeaders['Content-Range'] = originRes.headers['content-range'];

          res.writeHead(originRes.statusCode === 206 ? 206 : 200, outHeaders);
        }

        originRes.on('data', (chunk) => {
          if (done) { originRes.destroy(); return; }

          byteOffset += chunk.length;

          const ok = res.write(chunk);
          if (!ok) {
            originRes.pause();
            res.once('drain', () => {
              if (!done) originRes.resume();
            });
          }
        });

        originRes.once('end', () => {
          terminate(200, null);
        });

        originRes.once('error', (err) => {
          if (done) return;
          retry(byteOffset, `originRes: ${err.message}`);
        });
      });

      originReq.setTimeout(25000, () => {
        originReq.destroy(new Error('timeout'));
      });

      originReq.once('error', (err) => {
        if (done) return;
        retry(byteOffset, `originReq: ${err.message}`);
      });

      originReq.end();
    }

    function retry(fromByte, reason) {
      if (done) return;

      retries++;
      if (retries > MAX_RETRIES) {
        console.error(`[streamVideo] sin más reintentos — ${reason}`);
        return terminate(502, 'Error al conectar con el origen del video');
      }

      const delay = RETRY_BASE_MS * retries;
      console.warn(`[streamVideo] reintento ${retries}/${MAX_RETRIES} en ${delay}ms — ${reason}`);
      setTimeout(() => connect(fromByte), delay);
    }

    connect(byteOffset);
  }

  return { validateVideoUrl, proxyImage, streamVideo };
})();

// ============================================================================
// MÓDULO: SCRAPERS (mantener igual)
// ============================================================================
const ScraperModule = (() => {
  function slugify(text) {
    return text
      .toString()
      .normalize("NFD")                   // separar acentos
      .replace(/[\u0300-\u036f]/g, "")    // quitar acentos
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")        // reemplazar todo lo raro por "-"
      .replace(/^-+|-+$/g, "")            // quitar "-" al inicio/final
      .replace(/-{2,}/g, "-");            // evitar "--"
  }

  async function extractAnimeFLV(data) {

    const info = data.match(ParseModule.ANIME_INFO);
    const eps = data.match(ParseModule.EPISODES);
    if (!info || !eps) return null;

    const anime_info = ParseModule.safeEval(info[1]);
    const episodesRaw = ParseModule.safeEval(eps[1]);
    const pattern = await PatternModule.getAnimeFLVPattern();

    // cargar en cheerio
    const $ = cheerio.load(data);
    const tags = [];
    $('.Nvgnrs a').each((_, el) => {
      const tagText = $(el).text().trim();
      if (tagText) tags.push(tagText);
    });

    const episodes = episodesRaw.map(e => {
      const num = Array.isArray(e) ? e[0] : e;
      return { number: num, img: pattern.thumbnail(anime_info[0], num) };
    });

    return {
      source: 'AnimeFLV', title: anime_info[2], slug: anime_info[1],
      animeId: anime_info[0], isNewEP: anime_info[3],
      isEnd: anime_info.length === 3, episodes_count: episodes.length, episodes, tags
    };
  }

  async function extractTio(data) {
    const info = data.match(ParseModule.ANIME_INFO);
    const eps = data.match(ParseModule.EPISODES);
    if (!info || !eps) return null;

    const anime_info = ParseModule.safeEval(info[1]);
    const episodesRaw = ParseModule.safeEval(eps[1]);
    const pattern = await PatternModule.getTioPattern();
    const $ = cheerio.load(data)
    const tags = []
    $('.genres a').each((index, element) => {
      tags.push($(element).text().trim());
    });

    const episodes = episodesRaw.map(e => {
      const num = Array.isArray(e) ? e[0] : e;
      return { number: num, url: pattern.episode(anime_info[1], num), img: pattern.thumbnail(anime_info[0]) };
    });

    return {
      source: 'TIO', title: anime_info[2], slug: anime_info[1],
      animeId: anime_info[0], isNewEP: anime_info[3],
      isEnd: anime_info.length === 3, episodes_count: episodes.length, episodes, langs: "JP",
      subtitles: "ES", tags
    };
  }

  async function extractone(data) {
    const $ = cheerio.load(data);

    // 1️⃣ Detectar si el anime está finalizado
    const statusText = $('.st.c-f span').text().trim();
    const isEnd = statusText.toLowerCase() === 'finalizado';

    // 2️⃣ Extraer la variable eps del <script>
    const scriptText = $('script')
      .map((i, el) => $(el).html())
      .get()
      .find(t => t.includes('var eps ='));

    let episodes = [];
    const animeId = $('#r .info-r').attr('data-ai'); // ID para thumbnails
    const title = $('.info-l figure img').attr('alt') || '';
    const slug = slugify(title);
    const tags = $(".gn a").map((i, el) => $(el).text().trim()).get();
    if (scriptText) {
      const match = scriptText.match(/var eps = (\[.*?\]);/s);
      if (match) {
        const epsArray = JSON.parse(match[1]);
        episodes = epsArray.map(e => ({
          number: e[0],
          url: `https://vww.animeflv.one/ver/${slug}-${e[0]}`, // puedes cambiar a la URL real del episodio
          img: `https://vww.animeflv.one/cdn/img/episodios/${animeId}-${e[0]}.webp?t=0.1`
        }));
      }
    }

    // 4️⃣ Extraer fecha del próximo episodio si existe
    let isNewEP = null;
    const nextEpEl = $('ul.ep.prox li div span strong');
    if (nextEpEl.length) {
      isNewEP = nextEpEl.text().trim();
    }

    // 5️⃣ Devolver JSON completo
    return {
      source: "one",
      title,
      slug,
      isNewEP,
      isEnd,
      episodes_count: episodes.length,
      episodes,
      langs: "JP",
      subtitles: "ES",
      tags
    };
  }

  async function extractJK(url) {
    const client = axios.create({
      withCredentials: true,
      headers: {
        "User-Agent": "Mozilla/5.0"
      }
    });

    // 1️⃣ GET inicial
    const { data: html, headers } = await client.get(url);
    const $ = cheerio.load(html);

    const token = $('meta[name="csrf-token"]').attr("content");
    const cookies = headers["set-cookie"]?.join("; ") || "";
    const tags = $('.card-bod li:contains("Generos: ") a').map((i, el) => $(el).text().trim()).get();
    const ogUrl = $('meta[property="og:url"]').attr("content") || url;
    const slug = ogUrl.split("/").filter(Boolean).pop();

    const animeId = $("#guardar-anime").attr("data-anime");

    const thumbnail =
      $(".anime_pic img").attr("src") ||
      $('meta[property="og:image"]').attr("content") ||
      null;

    const statusText = $(".enemision").text().trim().toLowerCase();
    const isEnd = statusText.includes("concluido") || statusText.includes("finalizado");
    const isNewEP = statusText.includes("emision") ? true : null;

    const { data: firstRes } = await client.post(
      `https://jkanime.net/ajax/episodes/${animeId}/1`,
      new URLSearchParams({ _token: token }),
      {
        headers: {
          "Cookie": cookies,
          "Referer": url,
          "Origin": "https://jkanime.net",
          "X-Requested-With": "XMLHttpRequest"
        }
      }
    );
    const totalPages = firstRes.last_page;

    const requests = [];

    for (let page = 1; page <= totalPages; page++) {
      requests.push(
        client.post(
          `https://jkanime.net/ajax/episodes/${animeId}/${page}`,
          new URLSearchParams({ _token: token }),
          {
            headers: {
              "Cookie": cookies,
              "Referer": url,
              "Origin": "https://jkanime.net",
              "X-Requested-With": "XMLHttpRequest"
            }
          }
        )
      );
    }

    const responses = await Promise.all(requests);

    const allEpisodes = responses.flatMap(r =>
      r.data.data.map(ep => ({
        number: ep.number,
        url: `https://jkanime.net/${slug}/${ep.number}/`,
        img: ep.image
          ? `https://cdn.jkdesa.com/assets/images/animes/video/image_thumb/${ep.image}`
          : thumbnail
      }))
    );

    // ordenar
    allEpisodes.sort((a, b) => a.number - b.number);

    const title = $('.anime_info h3').first().text();

    return {
      source: "jk",
      title,
      slug,
      isNewEP,
      isEnd,
      episodes_count: allEpisodes.length,
      episodes: allEpisodes,
      langs: "JP",
      subtitles: "ES",
      tags
    };
  }

  async function extractAniyae(html) {
    //remove fuctions
  }

  async function extractTioHentai(html) {
    const $ = cheerio.load(html);

    // ===============================
    // 1️⃣ TITLE
    // ===============================
    const title = $('h1.title').first().text().trim();

    // ===============================
    // 2️⃣ SLUG + ID (desde JS)
    // ===============================
    const animeInfoMatch = html.match(/var\s+anime_info\s*=\s*(\[[^\]]+\])/);

    let animeID = null;
    let slug = null;

    if (animeInfoMatch) {
      try {
        const animeInfo = JSON.parse(animeInfoMatch[1]);
        animeID = animeInfo[0];
        slug = animeInfo[1];
      } catch { }
    }

    // ===============================
    // 3️⃣ ESTADO
    // ===============================
    const statusText = $('.status').text().toLowerCase();
    const tags = $('.generes a').map((i, el) => $(el).text().trim()).get();
    const isEnd = statusText.includes('finalizado');

    // ===============================
    // 4️⃣ IMAGEN (fallback para episodios)
    // ===============================
    let cover = $('.thumb img').attr('src');

    if (cover && cover.startsWith('/')) {
      cover = 'https://tiohentai.com' + cover;
    }

    // ===============================
    // 5️⃣ EPISODIOS (desde JS)
    // ===============================
    const episodesMatch = html.match(/var\s+episodes\s*=\s*(\[[^\]]+\])/);

    let episodes = [];

    if (episodesMatch) {
      try {
        const epsArray = JSON.parse(episodesMatch[1]);

        episodes = epsArray.map(num => ({
          number: num,
          url: `/ver/${slug}/${num}`,
          img: cover // 👈 fallback
        }));
      } catch { }
    }

    // ordenar (por si vienen invertidos)
    episodes.sort((a, b) => a.number - b.number);

    // ===============================
    // 6️⃣ NUEVO EP
    // ===============================
    let isNewEP = null;

    if (!isEnd && episodes.length) {
      isNewEP = episodes[episodes.length - 1].number;
    }

    // ===============================
    // 7️⃣ RESULTADO
    // ===============================
    return {
      source: "tiohentai",
      title,
      slug,
      isEnd,
      isNewEP,
      episodes_count: episodes.length,
      episodes,
      langs: "JP",
      subtitles: "ES",
      tags
    };
  }

  async function extractHentaila(html) {
    const $ = cheerio.load(html);

    // ===============================
    // 1️⃣ TITLE (desde sr-only)
    // ===============================
    const rawTitle = $('article a span.sr-only').first().text().trim();

    // Ej: "Ver Showtime! Uta no Onee-san Datte Shitai 2 1"
    const title = $('h1.text-lead').first().text().trim();
    const slug = slugify(title);

    // ===============================
    // 2️⃣ ESTADO (Finalizado / En emisión)
    // ===============================
    const metaText = $('.flex.flex-wrap.items-center').text().toLowerCase();
    const tags = $(".btn-line-o.rounded-full").map((i, el) => $(el).text().trim()).get();
    const isEnd = metaText.includes('finalizado');

    // ===============================
    // 3️⃣ EPISODIOS
    // ===============================
    const episodes = [];

    $('article.group\\/item').each((i, el) => {
      const ep = $(el);

      // número
      const number = Number(
        ep.find('.text-lead').text().trim()
      );

      // url
      const url = "https://hentaila.com" + ep.find('a').attr('href');

      // imagen
      const img = ep.find('img').attr('src');

      episodes.push({
        number,
        url,
        img
      });
    });

    // ===============================
    // 4️⃣ NUEVO EP
    // ===============================
    let isNewEP = null;
    if (!isEnd && episodes.length) {
      isNewEP = episodes[episodes.length - 1].number;
    }

    // ===============================
    // 5️⃣ RESULTADO FINAL
    // ===============================
    return {
      source: "hentaila",
      title,
      slug,
      isNewEP,
      isEnd,
      episodes_count: episodes.length,
      episodes,
      langs: "JP",
      subtitles: "ES",
      tags
    };
  }

  async function extractTmonet(url) {
    const mangaPath = new URL(url).pathname;
    const p = "https://zonatmo.net/wp-api/api/single" + mangaPath;

    let data = (await axiosGet(p, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept': '*/*',
        'Referer': p
      }
    })).data;
    const dat = JSON.parse(data)

    const slug = dat.data.slug;
    const title = dat.data.title;
    const isEnd = dat.data.status[0] === 19;
    const tags = [];
    const genid = dat.data.genres;

    for (const id of genid) {
      const genfind = genmap[id];
      if (genfind) { tags.push(genfind.name); }
    }

    const chapters = [];
    let currentPage = 1;
    let totalPages = 1;

    do {
      const chaptersUrl = `https://zonatmo.net/wp-api/api/single${mangaPath}/chapters?page=${currentPage}&postsPerPage=50&order=desc`;
      try {
        const chaptersRest = (await axiosGet(chaptersUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0',
            'Accept': '*/*',
            'Referer': p
          }
        })).data;
        const chaptersRes = JSON.parse(chaptersRest)

        if (chaptersRes && !chaptersRes.error && chaptersRes.data) {
          const items = chaptersRes.data.items || [];
          for (const item of items) {
            chapters.push({
              number: item.chapter_number,
              url: "https://zonatmo.net" + mangaPath + "/" + item.slug,
              img: "https://zonatmo.net/wp-content/uploads" + dat.data.cover
            });
          }

          if (chaptersRes.data.pagination) {
            totalPages = chaptersRes.data.pagination.total_pages;
          }
        } else {
          break;
        }
      } catch (error) {
        console.error(`Error obteniendo capítulos de la página ${currentPage}:`, error);
        break;
      }

      currentPage++;
    } while (currentPage <= totalPages);
    const chps = chapters.reverse();
    return {
      source: "tmonet",
      title,
      slug,
      isEnd,
      chapter_count: chapters.length,
      "chapters": chps,
      tags
    };
  }

  async function extractesp(html, mangaSlug) {
    const cheerio = require('cheerio');
    let $ = cheerio.load(html);

    const source = 'esp';
    const title = $('.manga-title').text().trim();

    // Detectar el slug correcto desde la URL o el body
    const slug = $('body').attr('data-manga-slug') || mangaSlug || 'suzuka';

    const statusText = $('.status-text').text().trim().toLowerCase();
    const isEnd = statusText.includes('finalizado') || statusText.includes('completado');
    const img = $('.manga-cover').attr('src') || '';

    const tags = [];
    $('.genero-item').each((i, el) => {
      tags.push($(el).text().trim());
    });

    // --- LÓGICA DE RECOLECCIÓN DE CAPÍTULOS RECURSIVA ---
    const chaptersRAW = [];

    async function fetchAllChapters(currentCheerio) {
      // 1. Extraer capítulos de la página/bloque actual
      currentCheerio('.chapter-card:not(.chapter-card-full):not(.continue-card) .chapter-link').each((i, el) => {
        const number = currentCheerio(el).attr('data-chapter') || '';
        let url = currentCheerio(el).attr('href') || '';

        if (url && url.startsWith('/')) {
          url = `https://MangaLect.org${url}`;
        }

        // Evitamos duplicados por si acaso el backend repite elementos
        if (number && !chaptersRAW.some(c => c.number === number)) {
          chaptersRAW.push({ number, url, img });
        }
      });

      // 2. Buscar el botón "Ver más"
      const moreLink = currentCheerio('#more-link').attr('href');

      if (moreLink && moreLink.includes('?before=')) {
        // CORRECCIÓN: La paginación mantiene la ruta base (/info/slug)
        const nextPageUrl = `https://MangaLect.org/info/${slug}/${moreLink}`;

        try {
          const response = await fetch(nextPageUrl, {
            headers: { 'X-Requested-With': 'XMLHttpRequest' } // Buenas prácticas para peticiones internas
          });

          if (response.ok) {
            const nextHtml = await response.text();
            const nextCheerio = cheerio.load(nextHtml);
            // Llamada recursiva pasando el nuevo contexto de Cheerio
            await fetchAllChapters(nextCheerio);
          }
        } catch (error) {
          console.error("Error al obtener más capítulos:", error);
        }
      }
    }

    // Iniciar la recolección con el HTML inicial
    await fetchAllChapters($);

    // Invertir al final para que queden ordenados cronológicamente
    const chapters = chaptersRAW.reverse();

    return {
      source,
      title,
      slug,
      isEnd,
      chapter_count: chapters.length,
      chapters,
      tags
    };
  }

  async function extractoly(seriesUrl, htmlContent) {
    const urlParts = seriesUrl.split('/series/');
    const fullSlug = urlParts[1] ? urlParts[1].split('?')[0] : '';
    const slug = fullSlug.replace(/^comic-/, '');

    const $ = cheerio.load(htmlContent);
    const nuxtDataRaw = $('#__NUXT_DATA__').html();

    let title = '';
    let img = '';
    let isEnd = false;
    let genres = [];

    if (nuxtDataRaw) {
      try {
        const data = JSON.parse(nuxtDataRaw);

        const series = data.find(item =>
          item &&
          typeof item === 'object' &&
          !Array.isArray(item) &&
          'name' in item &&
          'cover' in item &&
          'genres' in item &&
          'status' in item
        );

        if (series) {
          title = data[series.name] || '';
          img = data[series.cover] || '';

          const statusObj = data[series.status];
          if (statusObj && statusObj.name) {
            const statusText = data[statusObj.name];
            if (typeof statusText === 'string') {
              isEnd = statusText.toLowerCase().includes('finalizado');
            }
          }

          const genrePtrs = data[series.genres];
          if (Array.isArray(genrePtrs)) {
            genres = genrePtrs.map(ptr => {
              const g = data[ptr];
              return g && g.name ? data[g.name].trim() : '';
            }).filter(Boolean);
          }
        }
      } catch (e) { }
    }

    const allChapters = [];
    let currentPage = 1;
    let hasMorePages = true;

    while (hasMorePages) {
      const apiUrl = `https://panel.olympusxyz.com/api/series/${slug}/chapters?page=${currentPage}&direction=desc`;

      try {
        const response = await fetch(apiUrl);
        if (!response.ok) break;

        const apiData = await response.json();

        if (apiData && apiData.data && apiData.data.length > 0) {
          for (const ch of apiData.data) {
            allChapters.push({
              number: String(ch.name),
              url: `https://olympusxyz.com/capitulo/${ch.id}/${fullSlug}`,
              img: img
            });
          }

          if (apiData.links && apiData.links.next) {
            currentPage++;
          } else {
            hasMorePages = false;
          }
        } else {
          hasMorePages = false;
        }
      } catch (error) {
        hasMorePages = false;
      }
    }

    return {
      source: 'olympusxyz',
      title,
      slug: fullSlug,
      isEnd,
      chapter_count: allChapters.length,
      chapters: allChapters.reverse(),
      tags: genres

    };
  }
  function extractTmo(html, urlOriginal) {
    const $ = cheerio.load(html);

    const $header = $('.element-header-content');
    const $textInfo = $header.find('.element-header-content-text');

    const source = 'tmo';
    const title = $textInfo.find('.element-title').clone().children('small').remove().end().text().trim();
    const cover = $header.find('.book-thumbnail').attr('src');
    const slug = ((new URL(urlOriginal)).pathname).split('/').filter(Boolean).at(-1);
    const statusText = $('.book-status').text().toLowerCase().trim();
    let isEnd;
    if (statusText === "ended" | statusText === "cancelado" | statusText === "cancelado" | statusText === "finalizado") {
      isEnd = true
    } else { isEnd = false };

    const tags = [];
    $textInfo.find('h6 a.badge-primary').each((i, el) => {
      tags.push($(el).text().trim());
    });

    // 3. Extraer los capítulos
    const chapters = [];

    // Selector habitual para los contenedores o enlaces de los capítulos
    $('.upload-link').each((index, element) => {
      const $el = $(element);

      // 1. Número del capítulo (desde el atributo de datos o el texto)
      const numero = $el.attr('data-chapter-number') || $el.find('.chapter-number').attr('data-number');
      const linkLectura = $el.find('a.btn-primary').attr('href');

      chapters.push({
        num: numero ? parseFloat(numero) : null,
        url: linkLectura || null,
        img: cover
      });
    });

    return {
      source,
      title,
      slug,
      isEnd,
      chapter_count: chapters.length,
      "chapters": chapters.reverse(),
      tags
    };
  }
  function extractdorlat(html) {
    const $ = cheerio.load(html);
    const data = {
      source: 'dorlat',
      title: '',
      slug: '',
      isEnd: false,
      episodes_count: 0,
      lang: "LAT",
      isNewEP: '',
      tags: [],
      episodes: []
    };

    data.title = $('h1').text().trim() || $('title').text().trim();

    const canonical = $('link[rel="canonical"]').attr('href') || '';
    if (canonical) {
      data.slug = canonical.split('/').filter(Boolean).pop();
    }

    const infoText = $('.sheader .data').text().toLowerCase();
    data.isEnd = infoText.includes('finalizado');

    $('.sgeneros a').each((_, el) => {
      data.tags.push($(el).text().trim());
    });

    let epCounter = 1;
    $('.se-c').each((_, seasonEl) => {
      $(seasonEl).find('.episodios li').each((_, epEl) => {
        const number = epCounter++;
        const url = $(epEl).find('a').attr('href') || '';
        const image = $(epEl).find('img').attr('src') || '';

        if (url) {
          data.episodes.push({
            number,
            url,
            image
          });
        }
      });
    });

    data.episodes_count = data.episodes.length;

    if (data.episodes_count > 0) {
      data.isNewEP = data.episodes[data.episodes_count - 1].number;
    }

    return data;
  }
  async function extractdormp4(URLd) {
    const MAX_REINTENTOS = 5;
    const BASE = "https://doramasmp4.io";

    const html = await (await fetch(URLd)).text();

    const sid = new Set();
    const seasons = new Set();

    for (const match of html.matchAll(/\\?["']serie_id\\?["']\s*:\s*\\?["']([^"'\\]+)\\?["']/g)) {
      sid.add(match[1]);
    }

    for (const match of html.matchAll(/aria-controls=["'][^"']*season-panel-(\d+)["']/g)) {
      seasons.add(match[1]);
    }

    const IDS = await getSR(URLd);
    const serieIdEncontrado = [...sid][0] || "";
    // Ordenamos las temporadas numéricamente para procesarlas en orden correcto
    const temporadasEncontradas = seasons.size > 0
      ? [...seasons].sort((a, b) => parseInt(a) - parseInt(b))
      : ["1"];

    if (!serieIdEncontrado || !IDS || IDS.length === 0) return null;

    const titleMatch = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
    const title = titleMatch ? titleMatch[1].replace(/<!-- -->/g, "").trim() : "";

    const statusMatch = html.match(/Estado<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/);
    const estadoTxt = statusMatch ? statusMatch[1].replace(/<!-- -->/g, "").trim().toLowerCase() : "";
    const isEnd = estadoTxt.includes("finalizado") || estadoTxt.includes("terminado");

    const epsMatch = html.match(/Episodios<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/);
    const episodes_count = epsMatch ? parseInt(epsMatch[1].replace(/\D/g, "")) || 0 : 0;

    const tags = [...html.matchAll(/\/generos\/([^"'<>]+)/g)].map(m => {
      let tag = m[1];
      while (tag.endsWith('\\') || tag.endsWith('\\')) {
        tag = tag.slice(0, -1);
      }
      return tag.charAt(0).toUpperCase() + tag.slice(1);
    });

    const audioLanguages = [];
    const audioSectionMatch = html.match(/Idiomas de\s*audio<\/span>([\s\S]*?)<\/div>\s*<\/div>/i);
    if (audioSectionMatch) {
      for (const match of audioSectionMatch[1].matchAll(/<p class="text-foreground text-xs">([^<]+)<\/p>/g)) {
        audioLanguages.push(match[1].trim());
      }
    }

    const subtitles = [];
    const subSectionMatch = html.match(/Subtítulos<\/span>([\s\S]*?)<\/div>\s*<\/div>/i);
    if (subSectionMatch) {
      for (const match of subSectionMatch[1].matchAll(/title="Subtítulos disponibles:\s*([^"]+)"/g)) {
        subtitles.push(match[1].trim());
      }
    }

    async function probarSeason(id, seasonNum) {
      const BODY = [{
        season_number: parseInt(seasonNum),
        page: 1,
        limit: 99999,
        sort: "NUMBER_ASC",
        excludedLabelSlugs: "$undefined",
        brandHost: "doramasmp4.io",
        serie_id: serieIdEncontrado
      }];

      for (let intento = 1; intento <= MAX_REINTENTOS; intento++) {
        try {
          const res = await fetch(URLd, {
            method: "POST",
            headers: {
              "User-Agent": "Mozilla/5.0",
              "content-type": "text/x-component",
              "next-action": id,
              "accept": "text/x-component",
              "Referer": URLd,
              "Origin": BASE
            },
            body: JSON.stringify(BODY)
          });

          const txt = await res.text();
          const esValido = txt.includes("PaginationEpisodeResponse") && txt.includes(serieIdEncontrado);
          const invalido = !esValido || txt.includes('1:"$undefined"') || txt.includes('1:[]') || txt.includes('1:{"ok":false');

          if (!invalido) {
            return { id, seasonNum, txt };
          }
        } catch (e) { }
      }
      return null;
    }

    let actionIdValido = await Promise.any(
      IDS.map(async (id) => {
        const res = await probarSeason(id, temporadasEncontradas[0]);
        if (res) return res.id;
        throw new Error();
      })
    ).catch(() => null);

    if (!actionIdValido) {
      const freshIDS = await getSR(URLd, true);
      if (freshIDS && freshIDS.length > 0) {
        actionIdValido = await Promise.any(
          freshIDS.map(async (id) => {
            const res = await probarSeason(id, temporadasEncontradas[0]);
            if (res) return res.id;
            throw new Error();
          })
        ).catch(() => null);
      }
    }

    if (!actionIdValido) return null;

    // Procesamos en paralelo las temporadas
    const seasonResults = await Promise.all(
      temporadasEncontradas.map(season => probarSeason(actionIdValido, season))
    );
    const resultados = seasonResults.filter(Boolean);

    let contadorGlobal = 0;
    const formattedEpisodes = [];

    resultados.forEach((res) => {
      if (!res || !res.txt) return;

      try {
        const lines = res.txt.split("\n");
        for (const line of lines) {
          if (line.includes("PaginationEpisodeResponse") || line.includes("items")) {
            const colonIndex = line.indexOf(":");
            if (colonIndex !== -1) {
              const jsonStr = line.slice(colonIndex + 1).trim();
              const parsedData = JSON.parse(jsonStr);

              if (parsedData && Array.isArray(parsedData.items)) {
                parsedData.items.forEach(ep => {
                  contadorGlobal++;
                  formattedEpisodes.push({
                    num: contadorGlobal,
                    url: `${BASE}/capitulos/${ep.slug || ''}`,
                    img: ep.backdrop || ep.image || ep.poster || ''
                  });
                });
              }
            }
          }
        }
      } catch (e) { }
    });

    return {
      source: 'dormp4',
      title: title,
      slug: URLd.split("/").filter(Boolean).pop() || "",
      isEnd: isEnd,
      episodes_count: episodes_count || formattedEpisodes.length,
      isNewEP: '',
      tags: [...new Set(tags)],
      langs: audioLanguages,
      sub: subtitles,
      episodes: formattedEpisodes
    };
  }


  return {
    extractAnimeFLV,
    extractTio,
    extractone,
    extractJK,
    extractAniyae,
    extractTioHentai,
    extractHentaila,
    extractTmonet,
    extractesp,
    extractoly,
    extractTmo,
    extractdorlat,
    extractdormp4
  };
})();
// ============================================================================
// FUNCIONES PÚBLICAS CON CACHE CENTRALIZADO
// ============================================================================

async function getEpisodes(url) {
  if (!url) {
    return { success: false, error: 'URL vacía' };
  }

  // Intentar cargar desde caché (KeyCache guarda objetos directamente)
  const cacheKey = `episodes:${url}`;
  const cached = episodesCache.load(cacheKey);
  if (cached) {
    return cached;
  }

  try {
    const { data } = await HttpModule.axiosInstance.get(url, {
      headers: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache'
      }
    });
    const host = new URL(url).hostname;

    let result;

    if (/animeflv\.one$/.test(host)) {
      result = await ScraperModule.extractone(data);
    } else if (/animeflv\.net$/.test(host)) {
      result = await ScraperModule.extractAnimeFLV(data);
    } else if (/tioanime\./.test(host)) {
      result = await ScraperModule.extractTio(data);
    } else if (/hentaila\./.test(host)) {
      result = await ScraperModule.extractHentaila(data);
    } else if (/jkanime\./.test(host)) {
      result = await ScraperModule.extractJK(url);
    } else if (/aniyae\./.test(host)) {
      result = await ScraperModule.extractAniyae(data);
    } else if (/tiohentai\./.test(host)) {
      result = await ScraperModule.extractTioHentai(data);
    } else if (/zonatmo\.net$/.test(host)) {
      result = await ScraperModule.extractTmonet(url);
    } else if (/mangalect\.org$/.test(host)) {
      result = await ScraperModule.extractesp(data);
    } else if (/olympusxyz\./.test(host)) {
      result = await ScraperModule.extractoly(url, data);
    } else if (/zonatmo\.org$/.test(host)) {
      result = await ScraperModule.extractTmo(data, url);
    } else if (/doramaslat\./.test(host)) {
      result = await ScraperModule.extractdorlat(data);
    } else if (/doramasmp4\./.test(host)) {
      result = await ScraperModule.extractdormp4(url);
    } else {
      result = {
        success: false,
        error: `No hay extractor para host: ${host}`
      };
    }

    // Guardar en caché si hay resultados válidos (KeyCache guarda objetos directamente)
    if (result && (result.episodes?.length || result.chapters?.length)) {
      episodesCache.save(cacheKey, result);
    }

    return result;

  } catch (err) {
    console.error('[getEpisodes ERROR]', err.message);

    return {
      success: false,
      error: 'Error haciendo fetch o parsing',
      detail: err.message
    };
  }
}

async function getDescription(url) {
  if (!url) return '';

  // Intentar cargar desde caché (KeyCache guarda strings directamente)
  const cacheKey = `description:${url}`;
  const cached = descriptionCache.load(cacheKey);
  if (cached) {
    return cached;
  }

  try {
    const { data } = await HttpModule.axiosInstance.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "es-ES,es;q=0.9",
      },
      timeout: 10000
    });
    const $ = cheerio.load(data);
    const host = new URL(url).hostname;

    let nuxtDataRaw = null;
    if (/olympusxyz\./.test(host)) {
      nuxtDataRaw = $('#__NUXT_DATA__').html();
    }

    $('script, style, noscript').remove();

    const esBasura = (t) =>
      t.length < 80 ||
      ['ningún vídeo', 'alojado', 'nuestros servidores', 'correo',
        'plataforma', 'indexer', 'menores de edad', 'ver online'].some(w => t.toLowerCase().includes(w));

    let resultText = '';

    if (/animeflv\.(net|one)$/.test(host)) {
      resultText = $('section.WdgtCn .Description p').first().text().trim();
    } else if (/tioanime\./.test(host)) {
      resultText = $('aside p.sinopsis').first().text().trim();
    } else if (/tiohentai\./.test(host)) {
      resultText = $('aside p.sinopsis').first().text().trim();
    } else if (/hentaila\./.test(host)) {
      resultText = $('div.entry p').first().text().trim();
    } else if (/aniyae\./.test(host)) {
      resultText = $('div.border-l-2.pl-4').first().text().trim();
    } else if (/zonatmo\.net$/.test(host)) {
      const p = "https://zonatmo.net/wp-api/api/single" + (new URL(url)).pathname;
      const res = (axiosGet(p, {
        headers: {
          'User-Agent': 'Mozilla/5.0',
          'Accept': '*/*',
          'Referer': p
        }
      })).data;
      const data = JSON.parse(res);
      resultText = data.data.overview;
    } else if (/zonatmo\.org$/.test(host)) {
      resultText = $(".element-description").text().trim();
    } else if (/mangalect\.org$/.test(host)) {
      resultText = $("#synopsis-text").text().trim();
    } else if (/doramaslat\./.test(host)) {
      resultText = $('div.entry p, .wp-content p, .description p, .entry-content p').first().text().trim() ||
        $('.sheader .data .row p').first().text().trim();
    } else if (/doramasmp4\./.test(host)) {
      resultText = $('p.text-sm.leading-\\[20px\\]').text().trim();
    } else if (/olympusxyz\./.test(host)) {
      if (nuxtDataRaw) {
        try {
          const data = JSON.parse(nuxtDataRaw);
          let series = null;
          for (const item of data) {
            if (item && typeof item === 'object' && !Array.isArray(item)) {
              if ('summary' in item || 'description' in item) {
                series = item;
                break;
              }
            } else if (Array.isArray(item)) {
              series = item.find(sub => sub && typeof sub === 'object' && ('summary' in sub || 'description' in sub));
              if (series) break;
            }
          }

          if (series) {
            const stringIndex = series.summary || series.description;
            if (stringIndex && data[stringIndex]) {
              resultText = data[stringIndex]
                .trim()
                .replace(/\r?\n\s*\r?\n/g, '___PARRAFO___')
                .replace(/\r?\n/g, ' ')
                .replace(/___PARRAFO___/g, '\n\n')
                .replace(/[ ]+/g, ' ');
            }
          }
        } catch (e) {
          console.error("Error al extraer la sinopsis desde Nuxt JSON:", e);
        }
      }
    }

    // Fallback genérico
    if (!resultText) {
      resultText = $('p').map((_, el) => $(el).text().trim()).get().find(t => !esBasura(t)) ||
        $('[class*="sinopsis"] p').first().text().trim() ||
        $('[class*="sinopsis"]').first().text().trim() ||
        '';
    }

    // Guardar en caché si hay resultado (KeyCache guarda strings directamente)
    if (resultText) {
      descriptionCache.save(cacheKey, resultText);
    }

    return resultText;

  } catch (e) {
    console.error(`[getDescription ERROR - ${url}]:`, e.message);
    return '';
  }
}

/**
 * Verifica si una imagen existe y responde correctamente haciendo una solicitud HEAD
 * @param {string} imageUrl - URL de la imagen a verificar
 * @param {number} timeout - Tiempo de espera en milisegundos (default: 5000)
 * @returns {Promise<boolean>} - true si la imagen responde, false en caso contrario
 */
const checkImageExists = async (imageUrl, timeout = 5000) => {
  if (!imageUrl) return false;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    const response = await fetch(imageUrl, {
      method: 'HEAD',
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    clearTimeout(timeoutId);
    return response.ok;
  } catch (error) {
    console.error(`Error verificando imagen ${imageUrl}:`, error.message);
    return false;
  }
};

/**
 * Obtiene una imagen válida para el episodio o fallback al cover
 * @param {Object} item - El item del contenido
 * @param {number} epNum - Número de episodio
 * @param {Array} mirrors - Lista de mirrors a probar
 * @returns {Promise<string|null>} - URL de la imagen válida o null
 */
const getValidEpisodeImage = async (item, epNum, mirrors) => {
  // Primero intentar con los mirrors
  for (const mirrorKey of mirrors) {
    const sourceUrl = item.sources?.[mirrorKey];
    if (!sourceUrl) continue;
    try {
      const raw = await getEpisodes(sourceUrl);
      const found = raw?.episodes?.find(e => Number(e.number) === epNum);
      if (found?.img) {
        const exists = await checkImageExists(found.img);
        if (exists) {
          return found.img;
        }
      }
    } catch { }
  }

  // Si no se encontró en los mirrors, usar el cover como fallback
  const coverUrl = item.image || item.cover;
  if (coverUrl) {
    const exists = await checkImageExists(coverUrl);
    if (exists) {
      return coverUrl;
    }
  }

  return null;
};
// ============================================================================
// EXPORTS
// ============================================================================
module.exports = {
  getEpisodes,
  getDescription,
  checkImageExists,
  getValidEpisodeImage,
  proxyImage: StreamModule.proxyImage,
  streamVideo: StreamModule.streamVideo,
  validateVideoUrl: StreamModule.validateVideoUrl,
  downloadVideo: () => false
};