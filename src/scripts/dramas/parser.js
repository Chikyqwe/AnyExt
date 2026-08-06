const fs = require('fs');
const path = require('path');

// Configuración de rutas
const tmpFolder = path.join(__dirname, 'tmp');
const unitIdPath = path.join(__dirname, '..', '..', '..', 'data', 'drama', 'UnitID.json');
const unitAIdPath = path.join(__dirname, '..', '..', '..', 'data', 'UnitID.json');
const unitBIdPath = path.join(__dirname, '..', '..', '..', 'data', 'manga', 'UnitID.json');
const outputPath = path.join(__dirname, '..', '..', '..', 'data', 'drama', 'dramalist.json');

// Mapeo para normalizar los tipos de contenido a tus siglas (btype)
const typeMapping = {
    "TV": "D",
    "Dorama": "D"
};

// Lista de todas las fuentes posibles de dorama para inicializarlas en null por defecto
const fuentesDoramaPorDefecto = ['dormp4', 'dorlat'];

// Helper para limpiar y formatear el btype (fijado a 'D' para doramas)
function getBtype(typeStr) {
    return 'D';
}

// Helper para crear un objeto sources limpio con todas sus propiedades en null
function crearSourcesPorDefecto() {
    const defaultSources = {};
    fuentesDoramaPorDefecto.forEach(fuente => {
        defaultSources[fuente] = null;
    });
    return defaultSources;
}

async function combinarFuentes() {
    try {
        console.log("[INICIO] Combinando archivos JSON desde ./tmp...");

        // 1. Cargar base de datos de UnitIDs principal y las de corroboración (unitA y unitB)
        let unitIds = {};
        if (fs.existsSync(unitIdPath)) {
            unitIds = JSON.parse(fs.readFileSync(unitIdPath, 'utf-8'));
        } else {
            console.warn(`[WARN] No se encontró UnitID.json en la ruta especificada. Se creará uno nuevo.`);
        }

        let unitAIds = {};
        if (fs.existsSync(unitAIdPath)) {
            try {
                unitAIds = JSON.parse(fs.readFileSync(unitAIdPath, 'utf-8'));
            } catch (e) {
                console.warn(`[WARN] No se pudo leer unitAIdPath: ${e.message}`);
            }
        }

        let unitBIds = {};
        if (fs.existsSync(unitBIdPath)) {
            try {
                unitBIds = JSON.parse(fs.readFileSync(unitBIdPath, 'utf-8'));
            } catch (e) {
                console.warn(`[WARN] No se pudo leer unitBIdPath: ${e.message}`);
            }
        }

        // Buscar el ID numérico más alto actualmente entre todas las fuentes para no colisionar al generar nuevos
        const allLoadedIds = [
            ...Object.values(unitIds),
            ...Object.values(unitAIds),
            ...Object.values(unitBIds)
        ].filter(v => typeof v === 'number');

        let nextUnitId = allLoadedIds.length > 0 ? Math.max(...allLoadedIds) + 1 : 1000;

        // Un objeto Map nos ayuda a agrupar todo por Slug único de manera eficiente
        const diccionarioDoramas = new Map();

        // 2. Leer todos los archivos JSON temporales generados
        const archivosTmp = fs.readdirSync(tmpFolder).filter(file => path.extname(file) === '.json');

        for (const archivo of archivosTmp) {
            const nombreFuente = path.basename(archivo, '.json');
            const contenido = JSON.parse(fs.readFileSync(path.join(tmpFolder, archivo), 'utf-8'));

            if (!Array.isArray(contenido)) continue;

            for (const dorama of contenido) {
                if (!dorama.slug) continue;

                const slug = dorama.slug.trim();

                if (!diccionarioDoramas.has(slug)) {
                    // Inicializar estructura con la plantilla de fuentes por defecto en null
                    diccionarioDoramas.set(slug, {
                        title: dorama.title || '',
                        slug: slug,
                        image: dorama.image || '',
                        sources: crearSourcesPorDefecto(),
                        id: Math.floor(100000 + Math.random() * 900000),
                        unit_id: null,
                        btype: getBtype(dorama.type)
                    });
                }

                // Obtener referencia al registro unificado
                const doramaExistente = diccionarioDoramas.get(slug);

                // Reemplazar el null por la URL real encontrada
                doramaExistente.sources[nombreFuente] = dorama.url || null;
            }
        }

        // 3. Resolver unit_id corroborando primero en unitIds, luego en unitAIds y unitBIds
        const listaDoramas = [];
        let huboNuevosIds = false;

        for (const [slug, doramaData] of diccionarioDoramas.entries()) {
            if (unitIds[slug] !== undefined) {
                doramaData.unit_id = unitIds[slug];
            } else if (unitAIds[slug] !== undefined) {
                doramaData.unit_id = unitAIds[slug];
                unitIds[slug] = unitAIds[slug]; // Sincronizar con el principal
                huboNuevosIds = true;
            } else if (unitBIds[slug] !== undefined) {
                doramaData.unit_id = unitBIds[slug];
                unitIds[slug] = unitBIds[slug]; // Sincronizar con el principal
                huboNuevosIds = true;
            } else {
                unitIds[slug] = nextUnitId;
                doramaData.unit_id = nextUnitId;
                nextUnitId++;
                huboNuevosIds = true;
            }
            listaDoramas.push(doramaData);
        }

        // 4. CONSTRUIR ESTRUCTURA CON METADATA SOLICITADA
        const objetoFinalCompleto = {
            metadata: {
                creado_en: new Date().toISOString(),
                total_doramas: listaDoramas.length
            },
            doramas: listaDoramas
        };

        // 5. Guardar archivo final unificado
        fs.writeFileSync(outputPath, JSON.stringify(objetoFinalCompleto, null, 2), 'utf-8');
        console.log(`[SUCCESS] Combinación completada con éxito.`);
        console.log(` -> Total de doramas únicos procesados: ${listaDoramas.length}`);
        console.log(` -> Guardado en: ${outputPath}`);

        // 6. Si encontramos doramas nuevos o sincronizamos desde A/B, actualizamos el UnitID.json principal
        if (huboNuevosIds) {
            fs.writeFileSync(unitIdPath, JSON.stringify(unitIds, null, 2), 'utf-8');
            console.log(`[UPDATED] Se actualizaron/añadieron Slugs al archivo de control UnitID.json.`);
        }

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