const fs = require('fs');
const path = require('path');

// Configuración de rutas
const tmpFolder = path.join(__dirname, 'tmp');
const unitIdPath = path.join(__dirname, '..', '..', '..', 'data', 'manga', 'UnitID.json');
const unitAIdPath = path.join(__dirname, '..', '..', '..', 'data', 'UnitID.json');
const outputPath = path.join(__dirname, '..', '..', '..', 'data', 'manga', 'mangalist.json');

// Mapeo para normalizar los tipos de contenido a tus siglas (btype)
const typeMapping = {
    'manga': 'M',
    'manhwa': 'Mh',
    'manhua': 'Mha',
    'comic': 'C',
    'novela': 'N',
    'novel': 'N'
};

// Lista de todas las fuentes posibles de manga para inicializarlas en null por defecto
const fuentesMangaPorDefecto = ['tmo', 'oly', 'esp', 'tmonet'];

// Helper para limpiar y formatear el btype
function getBtype(typeStr) {
    if (!typeStr) return 'M';
    const cleanType = typeStr.toLowerCase().trim();
    return typeMapping[cleanType] || 'M';
}

// Helper para crear un objeto sources limpio con todas sus propiedades en null
function crearSourcesPorDefecto() {
    const defaultSources = {};
    fuentesMangaPorDefecto.forEach(fuente => {
        defaultSources[fuente] = null;
    });
    return defaultSources;
}

async function combinarFuentes() {
    try {
        console.log("[INICIO] Combinando archivos JSON desde ./tmp...");

        // 1. Cargar base de datos de UnitIDs existente
        let unitIds = {};
        if (fs.existsSync(unitIdPath)) {
            unitIds = JSON.parse(fs.readFileSync(unitIdPath, 'utf-8'));
        } else {
            console.warn(`[WARN] No se encontró UnitID.json en la ruta especificada. Se creará uno nuevo.`);
        }

        // Buscar el ID numérico más alto actualmente para no colisionar al generar nuevos
        const currentIds = Object.values(unitIds).filter(v => typeof v === 'number');
        let nextUnitId = currentIds.length > 0 ? Math.max(...currentIds) + 1 : 1000;

        // Un objeto Map nos ayuda a agrupar todo por Slug único de manera eficiente
        const diccionarioMangas = new Map();

        // 2. Leer todos los archivos JSON temporales generados
        const archivosTmp = fs.readdirSync(tmpFolder).filter(file => path.extname(file) === '.json');

        for (const archivo of archivosTmp) {
            const nombreFuente = path.basename(archivo, '.json'); // Ej: "tmo", "olympusxyz"
            const contenido = JSON.parse(fs.readFileSync(path.join(tmpFolder, archivo), 'utf-8'));

            if (!Array.isArray(contenido)) continue;

            for (const manga of contenido) {
                if (!manga.slug) continue;

                const slug = manga.slug.trim();

                if (!diccionarioMangas.has(slug)) {
                    // Inicializar estructura con la plantilla de fuentes por defecto en null
                    diccionarioMangas.set(slug, {
                        title: manga.title || '',
                        slug: slug,
                        image: manga.image || '',
                        sources: crearSourcesPorDefecto(),
                        id: Math.floor(100000 + Math.random() * 900000),
                        unit_id: null,
                        btype: getBtype(manga.type)
                    });
                }

                // Obtener referencia al registro unificado
                const mangaExistente = diccionarioMangas.get(slug);

                // Reemplazar el null por la URL real encontrada
                mangaExistente.sources[nombreFuente] = manga.url || null;
            }
        }

        // 3. Resolver unit_id y estructurar el Array temporal de mangas
        const listaMangas = [];
        let huboNuevosIds = false;

        for (const [slug, mangaData] of diccionarioMangas.entries()) {
            if (unitIds[slug] !== undefined) {
                mangaData.unit_id = unitIds[slug];
            } else {
                unitIds[slug] = nextUnitId;
                mangaData.unit_id = nextUnitId;
                nextUnitId++;
                huboNuevosIds = true;
            }
            listaMangas.push(mangaData);
        }

        // 4. CONSTRUIR ESTRUCTURA CON METADATA SOLICITADA
        const objetoFinalCompleto = {
            metadata: {
                creado_en: new Date().toISOString(),
                total_mangas: listaMangas.length
            },
            mangas: listaMangas
        };

        // 5. Guardar archivo final unificado en SQLite
        const Database = require('better-sqlite3');
        const dbPath = path.join(__dirname, '..', '..', '..', 'data', 'database.sqlite');
        const db = new Database(dbPath);

        // CORREGIDO:
        db.exec(`CREATE TABLE IF NOT EXISTS content (
        unit_id INTEGER PRIMARY KEY, id INTEGER, title TEXT, slug TEXT, 
        image TEXT, btype TEXT, contentType TEXT, sources TEXT
        )`);

        const insertContent = db.prepare(`
        INSERT OR REPLACE INTO content (unit_id, id, title, slug, image, btype, contentType, sources)
        VALUES (@unit_id, @id, @title, @slug, @image, @btype, @contentType, @sources)
        `);

        // 7. Limpiar archivos temporales en ./tmp sin borrar la carpeta
        const archivosParaBorrar = fs.readdirSync(tmpFolder);
        for (const archivo of archivosParaBorrar) {
            const rutaArchivo = path.join(tmpFolder, archivo);
            if (fs.statSync(rutaArchivo).isFile()) {
                fs.unlinkSync(rutaArchivo);
            }
        }
        console.log(`[CLEANUP] Se eliminaron ${archivosParaBorrar.length} archivo(s) temporales de ./tmp.`);

    } catch (error) {
        console.error(`[ERROR COMBINER] Falló la unificación de datos: ${error.message}`);
    }
}

if (process.send) {
    const meterInterval = setInterval(() => {
        process.send({
            type: 'RAM_TICK',
            rss: process.memoryUsage().rss
        });
    }, 50);
    meterInterval.unref();
}
if (global.gc) {
    global.gc();
}
combinarFuentes();