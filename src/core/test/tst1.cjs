'use strict';

const { extractAllVideoLinks } = require('../core'); // Asegúrate de que la ruta apunte correctamente a donde exportas la función

async function ejecutarTest() {
  const urlTest = 'https://tioanime.com/ver/ichijouma-mankitsugurashi-11';
  
  console.log('=== INICIANDO TEST DE EXTRACCIÓN ===');
  console.log(`URL objetivo: ${urlTest}\n`);

  try {
    // Ejecutamos el extractor principal que descargará la página y aplicará el require dinámico
    const resultado = await extractAllVideoLinks(urlTest);

    console.log('\n=== RESULTADO DEL TEST ===');
    if (Array.isArray(resultado)) {
      console.log(`Estructura devuelta correcta (Array). Total elementos: ${resultado.length}`);
      console.log('Contenido encontrado:');
      console.dir(resultado, { depth: null, colors: true });
    } else {
      console.error('⚠️ ALERTA: El extractor no devolvió un Array. Devolvió:', typeof resultado);
      console.log(resultado);
    }

  } catch (error) {
    console.error('❌ El test falló críticamente debido a un error no controlado:');
    console.error(error.stack);
  }
}

// Ejecutar el test
ejecutarTest();