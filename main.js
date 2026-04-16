import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

let scene, camera, renderer, controls, skyboxContainer = null;
const gltfLoader = new GLTFLoader();
const raycaster = new THREE.Raycaster(); // Prepped for your logo clicks
const mouse = new THREE.Vector2();

init();
animate();

function init() {
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x87ceeb); 

    camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 100000);
    camera.position.set(0, 2, 8); 

    const canvas = document.getElementById("vh-canvas");
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.2;

    scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 2.0));

    // --- SKYBOX LOADER ---
    gltfLoader.load('skybox.glb', (gltf) => {
        skyboxContainer = gltf.scene;
        const box = new THREE.Box3().setFromObject(skyboxContainer);
        const center = box.getCenter(new THREE.Vector3());
        
        skyboxContainer.position.sub(center); // Auto-center
        skyboxContainer.scale.setScalar(1000 / Math.max(...box.getSize(new THREE.Vector3()).toArray()));

        skyboxContainer.traverse((child) => {
            if (child.isMesh) {
                child.material.side = THREE.DoubleSide;
                if (child.material.map) {
                    child.material.emissive = new THREE.Color(0xffffff);
                    child.material.emissiveIntensity = 0.05;
                }
            }
        });
        scene.add(skyboxContainer);
    });

    // --- CONTROLS (Rotation Only) ---
    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.enableZoom = false; // Disabled to keep the balcony experience stable

    setupUI();
    window.addEventListener('resize', onWindowResize);
    window.addEventListener('click', onSceneClick); // Prepped for later
}

function setupUI() {
    // Using simple onclick to ensure they work
    const orbitBtn = document.getElementById('enter-orbit');
    const portalBtn = document.getElementById('enter-portal');
    const exitBtn = document.getElementById('back-from-portal');
    const landing = document.getElementById('landing-page');

    if(orbitBtn) orbitBtn.onclick = () => window.location.href = 'list.html';
    
    if(portalBtn) {
        portalBtn.onclick = () => {
            landing.style.display = 'none'; 
            exitBtn.style.display = 'block'; 
        };
    }

    if(exitBtn) {
        exitBtn.onclick = () => {
            exitBtn.style.display = 'none'; 
            landing.style.display = 'flex'; 
        };
    }
}

// This function is where the "Spotify/Apple" logic will live!
function onSceneClick(event) {
    // Logic for clicking 3D models goes here once you import them
    console.log("Scene clicked - ready for 3D logos!");
}

function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}

function animate() {
    requestAnimationFrame(animate);
    if (skyboxContainer) {
        skyboxContainer.position.copy(camera.position);
        skyboxContainer.position.y -= 3; 
    }
    controls.update();
    renderer.render(scene, camera);
}
