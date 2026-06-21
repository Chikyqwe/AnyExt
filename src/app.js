// src/app.js
console.log('[INFO] Iniciando aplicación AnyExt...');

const fs = require('fs');
const path = require('path');
require('dotenv').config({ quiet: true });
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const favicon = require('serve-favicon');

// Servicios y Utilidades
const { isMetadataStale } = require('./utils/CheckAnimeList');
const { iniciarMantenimiento } = require('./services/maintenanceService');

// Inicialización de Express y WebSocket
const app = express();
require('express-ws')(app);
console.log('[INFO] WebSocket configurado');

// Middleware Global
app.use(favicon(path.join(__dirname, '..', 'public', 'favicon.png')));
app.use(cors({ origin: (o, cb) => cb(null, true), credentials: true }));
app.use(cookieParser());
app.use(express.json());

// Configuración de Archivos Estáticos
const STATIC_SERVER_URL = process.env.STATIC_SERVER_URL;

if (STATIC_SERVER_URL) {
    console.log(`[INFO] Proxy para estáticos activado hacia: ${STATIC_SERVER_URL}`);
    const axios = require('axios');
    const proxyMiddleware = async (req, res, next) => {
        try {
            const url = `${STATIC_SERVER_URL}${req.originalUrl}`;
            const response = await axios({
                method: req.method,
                url: url,
                responseType: 'stream',
                validateStatus: () => true
            });
            res.status(response.status);
            for (const [key, value] of Object.entries(response.headers)) {
                res.setHeader(key, value);
            }
            response.data.pipe(res);
        } catch (error) {
            console.error(`[ERROR] Proxy falló para ${req.originalUrl}:`, error.message);
            next();
        }
    };
    app.use('/static', proxyMiddleware);
    app.use('/img', proxyMiddleware);
} else {
    const staticPaths = [
        { route: '/static', folder: 'static' },
        { route: '/img', folder: 'img' }
    ];

    staticPaths.forEach(({ route, folder }) => {
        app.use(route, express.static(path.join(__dirname, '..', 'public', folder)));
    });
}

// Middleware Fallback para archivos locales sueltos en public (ej. /styles_404.css, /404.png)
app.use((req, res, next) => {
    if (req.method !== 'GET') return next();
    try {
        const cleanUrl = req.path;
        const localPath = path.join(__dirname, '..', 'public', cleanUrl);
        if (fs.existsSync(localPath) && fs.statSync(localPath).isFile()) {
            return res.status(STATIC_SERVER_URL ? 503 : 200).sendFile(localPath);
        }
    } catch (e) {}
    next();
});

// ===================================================
// SISTEMA DE CARGA AUTOMÁTICA DE RUTAS
// ===================================================


/**
 * Escanea un directorio de forma recursiva buscando archivos de rutas
 */
function loadRoutes(directory) {
    if (!fs.existsSync(directory)) return;

    fs.readdirSync(directory).forEach(file => {
        const fullPath = path.join(directory, file);

        // 1. Si es una carpeta, entrar (Recursividad total)
        if (fs.statSync(fullPath).isDirectory()) {
            return loadRoutes(fullPath);
        }

        // 2. Solo archivos JS y que no sea este mismo archivo (app.js)
        if (!file.endsWith('.js') || fullPath === __filename) return;

        try {
            // 3. Leemos el archivo ANTES de cargarlo para decidir qué hacer
            const fileContent = fs.readFileSync(fullPath, 'utf8');
            const hasWsSupport = fileContent.includes('// ws.support=true');

            // Si el archivo no menciona "express" o "Router" y no tiene la etiqueta de WS, 
            // probablemente no es una ruta y lo saltamos para evitar errores.
            if (!fileContent.includes('express') && !hasWsSupport) {
                return;
            }

            const routeModule = require(fullPath);
            console.log('[R]: ' + fullPath)
            let router = null;

            // 4. Lógica de carga según el tipo
            if (hasWsSupport && typeof routeModule === 'function') {
                // Caso WS: Ejecutamos pasando la app
                router = routeModule(app);
                console.log(`[WS-ROUTE] Detectado y cargado: ${file}`);
            } else if (typeof routeModule === 'function' && routeModule.length === 1) {
                // Caso: Exporta función de un solo argumento (asumimos que es app)
                router = routeModule(app);
                console.log(`[FUNC-ROUTE] Cargado mediante inyección: ${file}`);
            } else if (routeModule && (Object.getPrototypeOf(routeModule) === express.Router || routeModule.stack)) {
                // Caso: Es un Router estándar exportado directamente
                router = routeModule;
                console.log(`[ROUTE] Cargado estándar: ${file}`);
            }

            // 5. Montaje final
            if (router) {
                app.use('/', router);
            }

        } catch (err) {
            // Si falla un archivo que no era una ruta, lo ignoramos silenciosamente
            // Si parece una ruta pero tiene error de sintaxis, lo avisamos
            if (err.message.includes('not a function') || err.message.includes('callback')) {
                console.error(`[DEBUG] Salto en ${file}: ${err.message}`);
            } else {
                console.error(`[DEBUG] Salto en ${file}: ${err.message}`);
            }
        }
    });
}

// 🔥 IMPORTANTE: Solo escaneamos la carpeta 'routes' para evitar conflictos
console.log('[INFO] Registrando rutas...');
loadRoutes(path.join(__dirname));

// ===================================================
// INICIALIZACIÓN DE SERVICIOS
// ===================================================

if (isMetadataStale()) {
    console.log('[MANTENIMIENTO] Metadata expirada, iniciando...');
    iniciarMantenimiento();
} else {
    console.log('[MANTENIMIENTO] Metadata vigente.');
}

// Manejo de errores 404
app.use((req, res) => {
    console.warn(`[ERROR 404] Ruta no encontrada: ${req.originalUrl}`);
    const fallbackPath = path.join(__dirname, '..', 'public', 'index.html');
    if (fs.existsSync(fallbackPath)) {
        res.status(404).sendFile(fallbackPath);
    } else {
        res.status(404).send('404 Not Found');
    }
});

console.log('[INFO] App lista para recibir conexiones.');

module.exports = app;