import NiiVue from '/vendor/niivuegpu/niivuegpu.webgl2.js?v=11';

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
    log('Starting Infinite Desktop...');
    const api = await fetch('/api').then(r => r.json());
    const volumeDefs = api.volumes || [];
    if (volumeDefs.length === 0) {
        log('No volumes found on server.');
        return;
    }

    const cols = 3, rows = 3, tileSize = 0.28, gap = 0.04;
    const instances = [];
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            const volDef = volumeDefs[(r * cols + c) % volumeDefs.length];
            instances.push({
                volDef,
                bounds: [[c*(tileSize+gap) + 0.05, r*(tileSize+gap) + 0.05], [c*(tileSize+gap)+tileSize + 0.05, r*(tileSize+gap)+tileSize + 0.05]]
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
            showBoundsBorder: true,
            isColorbarVisible: false,
            loadingText: '',
            placeholderText: ''
        });
        
        await nv.attachToCanvas(canvas);
        nv.sliceType = 4; // 3D Render
        
        const url = inst.volDef.levels?.find(l => l.level === 2) 
            ? `/volumes/${inst.volDef.id}/raw?level=2` 
            : `/volumes/${inst.volDef.id}/raw`;
        
        log(`Loading tile ${i+1}/${instances.length}: ${inst.volDef.id}...`);
        await nv.loadVolumes([{ url, colormap: 'Gray' }]);
        nvs.push(nv);
        
        // Trigger redraw to keep tiles visible as they load
        nv.drawScene(); 
    }

    log('All tiles loaded. Grid ready.');

    let viewport = { pan: [0, 0], zoom: 1 };
    let currentMode = 'world';

    const updateAll = () => {
        // MASTER CLEAR: Since we use preserveDrawingBuffer, we MUST clear the 
        // whole canvas before tiles redraw.
        const gl = canvas.getContext('webgl2');
        if (gl) {
            gl.disable(gl.SCISSOR_TEST); // Clear entire buffer
            gl.clearColor(0.05, 0.05, 0.05, 1);
            gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        }
        
        // Coordination: Only call setViewport on the FIRST tile.
        // The library core now fans this out to all siblings.
        if (nvs.length > 0) {
            nvs[0].setViewport(viewport);
        }
    };

    navModeEl.onchange = () => {
        currentMode = navModeEl.value;
        log('Mode changed to: ' + currentMode);
        
        for (const nv of nvs) {
            // Toggle drag mode on each instance
            // 0 = NONE, 1 = Standard (rotate/pan)
            nv.opts.dragMode = (currentMode === 'world') ? 0 : 1;
        }
    };
    navModeEl.value = 'world';
    navModeEl.onchange();

    canvas.addEventListener('wheel', (e) => {
        if (currentMode !== 'world') return;
        e.preventDefault();
        const delta = e.deltaY > 0 ? 0.9 : 1.1;
        viewport.zoom *= delta;
        updateAll();
    }, { passive: false });

    let isPanning = false;
    let lastPos = [0, 0];
    
    canvas.addEventListener('pointerdown', (e) => {
        if (currentMode === 'world' && e.button === 0) {
            isPanning = true;
            lastPos = [e.clientX, e.clientY];
            canvas.setPointerCapture(e.pointerId);
        }
    });

    canvas.addEventListener('pointermove', (e) => {
        if (!isPanning) return;
        // Check for 0 canvas size to prevent disappearing tiles
        if (canvas.width === 0 || canvas.height === 0) return;
        
        viewport.pan[0] += (e.clientX - lastPos[0]) / (canvas.width / window.devicePixelRatio);
        viewport.pan[1] -= (e.clientY - lastPos[1]) / (canvas.height / window.devicePixelRatio);
        lastPos = [e.clientX, e.clientY];
        updateAll();
    });

    canvas.addEventListener('pointerup', (e) => {
        if (isPanning) {
            isPanning = false;
            canvas.releasePointerCapture(e.pointerId);
        }
    });
    
    canvas.addEventListener('contextmenu', e => e.preventDefault());

    colormapEl.onchange = () => {
        const cm = colormapEl.value;
        for (const nv of nvs) {
            nv.setVolume(0, { colormap: cm });
            nv.drawScene();
        }
    };

    updateAll();
    log('Ready! Drag to pan, scroll to zoom.');
}

main().catch(err => {
    console.error(err);
    log('FATAL: ' + err.message);
});
