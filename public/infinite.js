import NiiVue, { NVCanvasViewportController } from '/vendor/niivuegpu/niivuegpu.webgl2.js?v=70';

const canvas = document.getElementById('nv-canvas');
const navModeEl = document.getElementById('navMode');
const colormapEl = document.getElementById('colormap');
const logEl = document.getElementById('debug-log');

const log = (msg) => {
    const div = document.createElement('div');
    div.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
    logEl.appendChild(div);
    logEl.scrollTop = logEl.scrollHeight;
};

async function main() {
    log('Starting Coordinated Static Sheet...');
    const api = await fetch('/api').then(r => r.json());
    const volumeDefs = api.volumes || [];
    if (volumeDefs.length === 0) return;

    const cols = 10, rows = 9;
    const tileSize = 0.1, gap = 0.0; 
    
    const instances = [];
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            const volDef = volumeDefs[(r * cols + c) % volumeDefs.length];
            instances.push({
                volDef,
                bounds: [[c*tileSize, r*tileSize], [(c+1)*tileSize, (r+1)*tileSize]]
            });
        }
    }

    log(`Initializing ${instances.length} tiles...`);
    const nvs = [];
    for (let i = 0; i < instances.length; i++) {
        const inst = instances[i];
        const nv = new NiiVue({
            backgroundColor: [0.1, 0.1, 0.1, 1],
            bounds: inst.bounds,
            showBoundsBorder: false,
            isColorbarVisible: false,
            loadingText: '',
            placeholderText: '',
            isInteractionEnabled: false, // World navigation mode by default
            isDragDropEnabled: false,
            preserveDrawingBuffer: true 
        });
        
        await nv.attachToCanvas(canvas);
        nv.sliceType = 4; // 3D Render
        
        const url = inst.volDef.levels?.find(l => l.level === 3) 
            ? `/volumes/${inst.volDef.id}/raw?level=3` 
            : `/volumes/${inst.volDef.id}/raw?level=2`;
        
        if (i % 20 === 0) log(`Loading tile ${i+1}/${instances.length}...`);
        await nv.loadVolumes([{ url, colormap: 'Gray' }]);
        nvs.push(nv);
    }

    log('Grid ready. Coordination active.');

    let viewport = { pan: [0, 0], zoom: 1 };
    let currentMode = 'world';

    if (NVCanvasViewportController) {
        const controller = new NVCanvasViewportController(canvas, {
            apply: (vp) => {
                if (currentMode === 'world') {
                    viewport = vp;
                    // Library handles sibling sync internally via setViewport -> requestSyncFrame
                    if (nvs.length > 0) nvs[0].setViewport(viewport);
                }
            },
            getViewport: () => viewport,
            panButton: 0,
            minZoom: 0.001, 
            maxZoom: 500,
            inertia: true
        });
        controller.attach();

        navModeEl.onchange = () => {
            currentMode = navModeEl.value;
            log('Mode: ' + currentMode);
            if (currentMode === 'world') {
                controller.setOptions({ panButton: 0, wheelEnabled: true });
                for (const nv of nvs) nv.disableInteraction();
            } else {
                controller.setOptions({ panButton: -1, wheelEnabled: false });
                for (const nv of nvs) nv.enableInteraction();
            }
        };
        // Ensure starting state is synchronized
        navModeEl.value = 'world';
        navModeEl.onchange();
    }

    colormapEl.onchange = (e) => {
        const cm = e.target.value;
        for (const nv of nvs) {
            nv.setVolume(0, { colormap: cm });
        }
    };

    // Initial render
    if (nvs.length > 0) nvs[0].setViewport(viewport);
    log('Ready! Panning/Zooming will now affect all tiles uniformly.');
}

main().catch(err => {
    console.error(err);
    log(`FATAL: ${err.message}`);
});
