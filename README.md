<p align="center">
  <img src="./public/logo.svg" alt="AnyEXT Logo" width="900" />
</p>

![Node.js >=22](https://img.shields.io/badge/Node.js-%3E%3D22-blue)
![Npm >=10](https://img.shields.io/badge/Npm-%3E%3D10-red)
![Licencia](https://img.shields.io/github/license/Chikyqwe/AnyExt?color=yellow)

AnyExt es un servidor web diseñado para la visualización de anime mediante streaming.

Instalación
===========

1. Instala las dependencias:

   ```bash
   npm install
   ```

2. Inicia el servidor:

   ```bash
   npm start
   ```

3. Abre el navegador en:

   ```
   http://localhost:{PORT}
   ```


Consideraciones
===============

- Este proyecto no almacena ni redistribuye contenido multimedia.
- Todos los enlaces de reproducción son obtenidos en tiempo real desde fuentes públicas mediante navegación automatizada.
- AnyExt está diseñado únicamente con fines educativos, de prueba o desarrollo personal.
- El uso de este software para propósitos comerciales o de redistribución puede violar los términos de uso de terceros.
- AnyExt no esta monetizado, ni contiene anuncios.

# Estructura del proyecto:
```text
.
├── about
│   ├── DOCUMENTATION.md
│   ├── ejemplo.rest
│   ├── LICENSE
│   └── plan.rest
├── data
│   ├── anime_list.json
│   ├── debg
│   │   ├── fixBugs.js
│   │   └── searchBugs.js
│   ├── drama
│   │   ├── dramalist.json
│   │   └── UnitID.json
│   ├── lastep.json
│   ├── manga
│   │   ├── mangalist.json
│   │   └── UnitID.json
│   └── UnitID.json
├── main.js
├── node
│   └── node_modules.bin
├── package.json
├── package-lock.json
├── public
│   ├── err.png
│   ├── favicon.png
│   ├── index.html
│   └── logo.svg
├── README.md
└── src
    ├── app.js
    ├── config
    │   └── index.js
    ├── controllers
    │   ├── animeController.js
    │   ├── dramaController.js
    │   ├── imageController.js
    │   ├── mangaController.js
    │   ├── mediaController.js
    │   └── viewController.js
    ├── core
    │   ├── cache
    │   │   ├── cache.js
    │   │   └── cacheStorage.js
    │   ├── core.js
    │   ├── helpersCore.js
    │   ├── models
    │   │   ├── basic_models
    │   │   │   ├── ay.js
    │   │   │   ├── dorlat.js
    │   │   │   ├── dormp4.js
    │   │   │   ├── generic.js
    │   │   │   ├── helpers
    │   │   │   │   ├── flix.js
    │   │   │   │   └── sr.js
    │   │   │   ├── hl.js
    │   │   │   ├── jk.js
    │   │   │   └── one.js
    │   │   ├── bc.js
    │   │   ├── jkum.js
    │   │   ├── manga_models
    │   │   │   ├── esp.js
    │   │   │   ├── oly.js
    │   │   │   ├── tmo.js
    │   │   │   └── tmonet.js
    │   │   ├── mp4.js
    │   │   ├── ok.js
    │   │   ├── st.js
    │   │   ├── sw.js
    │   │   ├── uq.js
    │   │   ├── voe.js
    │   │   └── yu.js
    │   ├── queue
    │   │   └── queueService.js
    │   ├── test
    │   └── tmp
    │       ├── data
    │       │   ├── cache
    │       │   ├── keys
    │       │   └── text
    │       └── reg.json
    ├── jobs
    │   └── maintenimanceWorker.js
    ├── middlewares
    │   ├── asyncHandler.js
    │   └── maintenanceBlock.js
    ├── past
    │   └── euba.py
    ├── routes
    │   ├── analytics.js
    │   ├── api.js
    │   ├── index.js
    │   ├── player.js
    │   └── views.js
    ├── scripts
    │   ├── anim.js
    │   ├── dramas
    │   │   ├── core.js
    │   │   ├── dorlat.js
    │   │   ├── dormp4.js
    │   │   ├── parser.js
    │   │   └── tmp
    │   ├── lastep.js
    │   └── manga
    │       ├── core.js
    │       ├── esp.js
    │       ├── olympus.js
    │       ├── parser.js
    │       ├── tmo.js
    │       ├── tmonet.js
    │       └── tmp
    ├── server
    │   ├── console.js
    │   ├── logger.js
    │   ├── maintenanceInterval.js
    │   ├── maintenanceScheduler.js
    │   ├── memoryMonitor.js
    │   └── server.js
    ├── server.js
    ├── services
    │   ├── emailService.js
    │   ├── jsonService.js
    │   ├── maintenanceService.js
    │   └── supabase
    │       ├── supabaseInt.js
    │       └── supabase.js
    ├── test
    │   └── link.js
    └── utils
        ├── CheckAnimeList.js
        ├── CheckMega.js
        ├── helpers.js
        ├── maps
        │   ├── map_2.json
        │   └── map.json
        └── status.js
```

web
===

Animeext tiene un servidor weeb en: [anyext](https://anyext-m5lt.onrender.com), que sirve para probar la web sin necesidad de tener un servidor web instalado.

Documentacion
=============

Para  consular la documentacion del proyecto, consultar el archivo [`DOCUMENTATION.md`](about/DOCUMENTATION.md)

Licencia
========

Este proyecto está licenciado bajo los términos de la Licencia [MIT](https://opensource.org/licenses/MIT).  
Consulta el archivo [`LICENSE`](about/LICENSE) para más información.

Autoría
=======

Desarrollado por [**Chikiqwe**](https://github.com/Chikyqwe)
<!-- Anime, streaming, Node.js, m3u8, browserless, scraper, reproductor -->