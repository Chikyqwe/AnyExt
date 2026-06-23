const cheerio = require('cheerio');
async function extractHL($) {
  const videos = [];

  try {
    // Buscar el script que contiene "kit.start"
    const scripts = $('script').map((_, el) => $(el).html()).get();

    const targetScript = scripts.find(s => s && s.includes('kit.start'));

    if (!targetScript) {
      console.log('[SUB] ❌ No se encontró el script con kit.start');
      return videos;
    }

    // Extraer el bloque donde está "embeds"
    const embedsMatch = targetScript.match(/embeds:\s*(\{[\s\S]*?\})\s*,\s*downloads:/);

    if (!embedsMatch) {
      console.log('[SUB] ❌ No se encontró embeds');
      return videos;
    }

    let embeds;

    try {
      embeds = eval('(' + embedsMatch[1] + ')'); // parseo rápido tipo objeto JS
    } catch (e) {
      console.log('[SUB] ❌ Error parseando embeds:', e.message);
      return videos;
    }

    if (!embeds.SUB || !Array.isArray(embeds.SUB)) {
      console.log('[SUB] ⚠️ No hay SUB');
      return videos;
    }

    embeds.SUB.forEach(v => {
      if (!v.url) return;

      videos.push({
        servidor: v.server.toLowerCase(),
        url: v.url
      });
    });

  } catch (e) {
    console.error('[SUB] ❌ Error general:', e.message);
  }

  return videos;
}

module.exports = { extractHL };