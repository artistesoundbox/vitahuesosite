import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// --- SETUP ---
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
const canvas = document.querySelector('#vh-canvas');
const renderer = new THREE.WebGLRenderer({ 
    canvas: canvas, 
    antialias: true,
    alpha: true 
});

renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

// --- CONTROLS (With Zoom Guardrails) ---
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.05;

// Safety limits: prevents "disappearing" geometry when zooming
controls.minDistance = 2;    // Prevents zooming too close/inside the model
controls.maxDistance = 60;   // Prevents zooming so far you lose the city
controls.maxPolarAngle = Math.PI / 1.5; // Prevents looking too far under the floor

// --- LIGHTING ---
scene.add(new THREE.AmbientLight(0xffffff, 1.2));
const light = new THREE.DirectionalLight(0xffffff, 1.5);
light.position.set(5, 10, 7.5);
scene.add(light);

// --- LOADING ---
const loader = new GLTFLoader();
let skyboxModel = null;

loader.load('skybox.glb', (gltf) => {
    skyboxModel = gltf.scene;
    scene.add(skyboxModel);
    console.log("✅ 3D City Loaded");
}, undefined, (err) => {
    console.error("❌ 3D Load Error:", err);
});

// Default starting position
camera.position.set(0, 1.6, 5);
controls.update();

// --- INTERACTION ---
const orbitBtn = document.getElementById('enter-orbit');
const portalBtn = document.getElementById('enter-portal');
const landingPage = document.getElementById('landing-page');
const backBtn = document.getElementById('back-from-portal');

if (orbitBtn) {
    orbitBtn.onclick = () => {
        console.log("🚀 Redirecting to list.html");
        window.location.href = "list.html"; 
    };
}

if (portalBtn) {
    portalBtn.onclick = () => {
        console.log("🌀 Entering Portal");
        camera.position.set(0, 1.6, -5);
        controls.target.set(0, 1.6, -20);
        landingPage.style.display = 'none';
        backBtn.style.display = 'block';
        controls.update();
    };
}

if (backBtn) {
    backBtn.onclick = () => {
        console.log("🔙 Exiting Portal");
        camera.position.set(0, 1.6, 5);
        controls.target.set(0, 1.6, 0);
        landingPage.style.display = 'block';
        backBtn.style.display = 'none';
        controls.update();
    };
}

// --- LOOP ---
function animate() {
    requestAnimationFrame(animate);
    
    // Smoothly update camera movement
    controls.update(); 
    
    if (skyboxModel) {
        skyboxModel.rotation.y += 0.0004;
    }
    
    renderer.render(scene, camera);
}

animate();

// --- RESIZE ---
window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});