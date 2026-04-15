import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

let scene, camera, renderer, controls, composer, traffic = [];
const textureLoader = new THREE.TextureLoader();

init();
animate();

function init() {
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x020408);
    scene.fog = new THREE.FogExp2(0x020408, 0.002);

    camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 1, 5000);
    camera.position.set(0, 150, 400);

    const canvas = document.getElementById("vh-canvas");
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    // LIGHTING - Boosted so it's not dark
    scene.add(new THREE.AmbientLight(0xffffff, 1.2));
    const dLight = new THREE.DirectionalLight(0xffffff, 0.5);
    dLight.position.set(200, 500, 200);
    scene.add(dLight);

    createEnvironment();

    // Load texture and build city
    textureLoader.load('windows.png', 
        (tex) => { buildCity(tex); }, 
        undefined, 
        () => { buildCity(null); } // Fallback if texture fails
    );

    createTrafficSystem(150);

    // BLOOM (Glow effect)
    const renderScene = new RenderPass(scene, camera);
    const bloomPass = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 1.5, 0.4, 0.85);
    composer = new EffectComposer(renderer);
    composer.addPass(renderScene);
    composer.addPass(bloomPass);

    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.autoRotate = true;

    setupUI();
}

function buildCity(tex) {
    const geo = new THREE.BoxGeometry(1, 1, 1);
    for (let i = 0; i < 100; i++) {
        const h = 40 + Math.random() * 150;
        const w = 30 + Math.random() * 20;
        
        const mat = new THREE.MeshLambertMaterial({ 
            color: 0x050505,
            emissive: 0x00ffff,
            emissiveIntensity: tex ? 2 : 0.5,
            emissiveMap: tex
        });

        if(tex) {
            tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
            mat.emissiveMap.repeat.set(w * 0.1, h * 0.05);
        }

        const b = new THREE.Mesh(geo, mat);
        let x = (Math.round((Math.random() - 0.5) * 10) * 200) + 100;
        let z = (Math.round((Math.random() - 0.5) * 10) * 200) + 100;
        b.scale.set(w, h, w);
        b.position.set(x, h/2, z);
        scene.add(b);
    }
}

function createEnvironment() {
    const ground = new THREE.Mesh(
        new THREE.PlaneGeometry(4000, 4000),
        new THREE.MeshStandardMaterial({ color: 0x111111 })
    );
    ground.rotation.x = -Math.PI / 2;
    scene.add(ground);
}

function createTrafficSystem(count) {
    const dotGeo = new THREE.SphereGeometry(1, 6, 6);
    const mat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    for (let i = 0; i < count; i++) {
        const dot = new THREE.Mesh(dotGeo, mat);
        dot.position.set((Math.random()-0.5)*2000, 2, (Math.random()-0.5)*2000);
        dot.userData = { speed: 2 + Math.random() * 3 };
        scene.add(dot);
        traffic.push(dot);
    }
}

function setupUI() {
    const orbitBtn = document.getElementById('enter-orbit');
    const portalBtn = document.getElementById('enter-portal');
    const exitBtn = document.getElementById('back-from-portal');
    const landing = document.getElementById('landing-page');

    orbitBtn.onclick = () => window.location.href = 'list.html';
    
    portalBtn.onclick = () => {
        landing.style.display = 'none';
        exitBtn.style.display = 'block';
    };

    exitBtn.onclick = () => {
        exitBtn.style.display = 'none';
        landing.style.display = 'flex';
    };
}

function animate() {
    requestAnimationFrame(animate);
    traffic.forEach(t => {
        t.position.x += t.userData.speed;
        if(t.position.x > 1000) t.position.x = -1000;
    });
    controls.update();
    composer.render();
}