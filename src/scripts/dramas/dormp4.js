const axios = require('axios');
const fs = require('fs');
const path = require("path")

const API_URL = 'https://userapi.cloudfleir.xyz/graphql';
const TOTAL_PAGES = 112;
const LIMIT_PER_PAGE = 24;
const BATCH_SIZE = 8; // 8 peticiones en paralelo a la vez
const outfolder = path.join(__dirname, "tmp")

const GRAPHQL_QUERY = `
  query PaginationDorama($sort: SortDorama, $limit: Int, $filter: FilterDoramasInput, $page: Int, $excludedLabelSlugs: [String!]) {
    paginationDorama(
      sort: $sort
      limit: $limit
      filter: $filter
      page: $page
      excludedLabelSlugs: $excludedLabelSlugs
    ) {
      items {
        _id
        name
        slug
        isTVShow
        poster_path
        poster
      }
    }
  }
`;

async function fetchPage(page) {
    const payload = {
        operationName: "PaginationDorama",
        variables: {
            page: page,
            limit: LIMIT_PER_PAGE,
            filter: { isTVShow: false }
        },
        extensions: {
            clientLibrary: {
                name: "@apollo/client",
                version: "4.0.7"
            }
        },
        query: GRAPHQL_QUERY
    };

    const response = await axios.post(API_URL, payload, {
        headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        },
        timeout: 0 // Sin timeout
    });

    return response.data?.data?.paginationDorama?.items || [];
}

async function fetchAllDoramas() {
    const resultados = [];
    const urlsUnicas = new Set();

    console.log(`Extrayendo ${TOTAL_PAGES} páginas en lotes de ${BATCH_SIZE}...`);

    // Crear la lista con los números de página [1, 2, ..., 112]
    const pages = Array.from({ length: TOTAL_PAGES }, (_, i) => i + 1);

    // Fragmentar en batches de 8
    for (let i = 0; i < pages.length; i += BATCH_SIZE) {
        const batch = pages.slice(i, i + BATCH_SIZE);
        console.log(`Lote: páginas ${batch[0]} a ${batch[batch.length - 1]}...`);

        // Ejecutar las 8 peticiones en paralelo
        const results = await Promise.allSettled(batch.map(page => fetchPage(page)));

        for (const res of results) {
            if (res.status === 'fulfilled') {
                const items = res.value;
                for (const item of items) {
                    const slug = item.slug || '';
                    const doramaUrl = `https://doramasmp4.io/doramas/${slug}`;

                    if (!urlsUnicas.has(doramaUrl)) {
                        urlsUnicas.add(doramaUrl);
                        resultados.push({
                            slug: slug,
                            title: item.name || '',
                            type: 'Dorama',
                            url: doramaUrl,
                            image: item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : (item.poster || '')
                        });
                    }
                }
            } else {
                console.error(`Error en una petición del lote:`, res.reason?.message);
            }
        }
    }

    if (!fs.existsSync(outfolder)) {
        fs.mkdirSync(outfolder, { recursive: true });
    }
    const outfile = path.join(outfolder, "dormp4.json")
    fs.writeFileSync(outfile, JSON.stringify(resultados, null, 2));
    console.log('[info] Resultados guardados exitosamente en ./tmp/doramas.json');
}
if (process.send) {
    const meterInterval = setInterval(() => {
        process.send({
            type: 'RAM_TICK',
            rss: process.memoryUsage().rss
        });
    }, 50);

    // Esto evita que el setInterval mantenga el script colgado al terminar
    meterInterval.unref();
}
if (global.gc) {
    global.gc();
}

fetchAllDoramas();