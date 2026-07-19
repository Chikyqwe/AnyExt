const { fork } = require('child_process');

/**
 * Lanza un proceso hijo con un canal de comunicación activo (IPC)
 * para monitorear su propio consumo máximo de memoria RAM.
 */
function runTask(scriptName) {
    return new Promise((resolve, reject) => {
        const child = fork(scriptName, [], { stdio: ['inherit', 'pipe', 'pipe', 'ipc'], execArgv: ['--max-old-space-size=380', '--expose-gc'] });
        let peakMemoryBytes = 0;

        // Escucha las métricas enviadas por el proceso hijo
        child.on('message', (message) => {
            if (message && message.type === 'RAM_TICK') {
                if (message.rss > peakMemoryBytes) {
                    peakMemoryBytes = message.rss;
                }
            }
        });

        // Captura de salidas estándar para la depuración
        child.stdout.on('data', (data) => console.log(`[${scriptName}]: ${data.toString().trim()}`));
        child.stderr.on('data', (data) => console.error(`[${scriptName} WARN]: ${data.toString().trim()}`));

        child.on('close', (code) => {
            if (code === 0) {
                const peakMb = (peakMemoryBytes / (1024 * 1024)).toFixed(2);
                resolve(peakMb);
            } else {
                reject(new Error(`Codigo de salida: ${code}`));
            }
        });

        child.on('error', reject);
    });
}

/**
 * Controla la ejecucion secuencial de la cola de tareas
 */
async function runPipeline() {
    const queue = ['./src/scripts/manga/esp.js', './src/scripts/manga/olympus.js', './src/scripts/manga/tmo.js', './src/scripts/manga/tmonet.js', './src/scripts/manga/parser.js'];

    console.log(`[START] Iniciando ejecucion secuencial de ${queue.length} tareas...\n`);

    for (const task of queue) {
        console.log(`[PROCESS] Ejecutando: ${task}...`);
        const startTime = Date.now();

        try {
            const peakRam = await runTask(task);
            const duration = ((Date.now() - startTime) / 1000).toFixed(2);

            console.log(`[OK] Tarea: ${task} | Tiempo: ${duration}s | Max RAM: ${peakRam} MB\n`);
        } catch (error) {
            console.error(`[ERROR] Fallo critico en: ${task}`);
            console.error(`Abortando la secuencia para evitar corrupcion de datos.\n`);
            return;
        }
    }

    console.log(`[END] Secuencia completada correctamente.`);
}
async function mainm() {
    await runPipeline();
};
module.exports = { mainm };
if (require.main === module) mainm();