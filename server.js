// Fireball explosion effect - ENHANCED WITH MORE PARTICLES
function createFireballExplosion(x, y, z) {
    // Main explosion particles - INCREASED FROM 30 TO 80 PARTICLES
    const particleCount = 80;
    const explosionGroup = new THREE.Group();
    
    // Core explosion flash
    const coreGeometry = new THREE.SphereGeometry(1.5, 16, 16);
    const coreMaterial = new THREE.MeshBasicMaterial({ 
        color: 0xffaa00,
        transparent: true,
        opacity: 0.8
    });
    const core = new THREE.Mesh(coreGeometry, coreMaterial);
    core.position.set(x + 0.5, y + 0.5, z + 0.5);
    explosionGroup.add(core);
    
    // Large fire particles
    for (let i = 0; i < particleCount; i++) {
        const size = 0.1 + Math.random() * 0.2;
        const geometry = new THREE.SphereGeometry(size, 8, 8);
        
        // Random fire colors
        const colors = [0xff5500, 0xffaa00, 0xff6600, 0xff8800];
        const color = colors[Math.floor(Math.random() * colors.length)];
        
        const material = new THREE.MeshBasicMaterial({ 
            color: color,
            transparent: true,
            opacity: 0.9
        });
        const particle = new THREE.Mesh(geometry, material);
        
        // Random direction in all directions with more variation
        const theta = Math.random() * Math.PI * 2;
        const phi = Math.random() * Math.PI;
        const speed = 2.5 + Math.random() * 3;
        
        particle.userData.velocity = {
            x: Math.sin(phi) * Math.cos(theta) * speed,
            y: Math.cos(phi) * speed,
            z: Math.sin(phi) * Math.sin(theta) * speed
        };
        particle.userData.life = 1.0;
        particle.userData.decay = 0.02 + Math.random() * 0.03;
        particle.userData.rotationSpeed = (Math.random() - 0.5) * 0.2;
        
        particle.position.set(x + 0.5, y + 0.5, z + 0.5);
        explosionGroup.add(particle);
    }
    
    // Add smoke particles
    const smokeCount = 40;
    for (let i = 0; i < smokeCount; i++) {
        const size = 0.15 + Math.random() * 0.25;
        const geometry = new THREE.SphereGeometry(size, 6, 6);
        const material = new THREE.MeshBasicMaterial({ 
            color: 0x333333,
            transparent: true,
            opacity: 0.7
        });
        const smoke = new THREE.Mesh(geometry, material);
        
        const theta = Math.random() * Math.PI * 2;
        const phi = Math.random() * Math.PI;
        const speed = 1.5 + Math.random() * 2;
        
        smoke.userData.velocity = {
            x: Math.sin(phi) * Math.cos(theta) * speed * 0.7,
            y: Math.abs(Math.cos(phi)) * speed * 1.5, // Smoke rises more
            z: Math.sin(phi) * Math.sin(theta) * speed * 0.7
        };
        smoke.userData.life = 1.0;
        smoke.userData.decay = 0.01 + Math.random() * 0.02;
        smoke.userData.growth = 1.0 + Math.random() * 0.5;
        
        smoke.position.set(x + 0.5, y + 0.5, z + 0.5);
        explosionGroup.add(smoke);
    }
    
    // Add fire rings
    const ringCount = 6;
    for (let i = 0; i < ringCount; i++) {
        const radius = 0.3 + Math.random() * 0.4;
        const segments = 12;
        const ringGeometry = new THREE.RingGeometry(radius, radius + 0.1, segments);
        const ringMaterial = new THREE.MeshBasicMaterial({
            color: 0xff5500,
            transparent: true,
            opacity: 0.8,
            side: THREE.DoubleSide
        });
        const ring = new THREE.Mesh(ringGeometry, ringMaterial);
        
        const angle = (i / ringCount) * Math.PI * 2;
        const distance = 0.8 + Math.random() * 0.6;
        
        ring.position.set(
            x + 0.5 + Math.cos(angle) * distance,
            y + 0.5 + Math.random() * 0.5,
            z + 0.5 + Math.sin(angle) * distance
        );
        
        // Random orientation
        ring.rotation.x = Math.random() * Math.PI;
        ring.rotation.y = Math.random() * Math.PI;
        
        ring.userData = {
            life: 1.0,
            decay: 0.04,
            scale: 1.0,
            expandSpeed: 3 + Math.random() * 4,
            rotateSpeed: (Math.random() - 0.5) * 0.1
        };
        
        explosionGroup.add(ring);
    }
    
    scene.add(explosionGroup);
    
    function animateExplosion() {
        let allDead = true;
        
        explosionGroup.children.forEach(object => {
            if (object.userData.life <= 0) return;
            
            object.userData.life -= object.userData.decay;
            
            if (object.userData.life > 0) {
                allDead = false;
                
                // Handle core flash
                if (object === core) {
                    object.material.opacity = object.userData.life * 0.8;
                    object.scale.setScalar(1 + (1 - object.userData.life) * 2);
                }
                // Handle fire particles
                else if (object.userData.velocity && !object.userData.growth) {
                    object.position.x += object.userData.velocity.x * 0.1;
                    object.position.y += object.userData.velocity.y * 0.1;
                    object.position.z += object.userData.velocity.z * 0.1;
                    object.material.opacity = object.userData.life;
                    object.scale.setScalar(object.userData.life * 0.8);
                    
                    // Add rotation to particles
                    if (object.userData.rotationSpeed) {
                        object.rotation.x += object.userData.rotationSpeed;
                        object.rotation.y += object.userData.rotationSpeed;
                    }
                }
                // Handle smoke particles
                else if (object.userData.velocity && object.userData.growth) {
                    object.position.x += object.userData.velocity.x * 0.1;
                    object.position.y += object.userData.velocity.y * 0.1;
                    object.position.z += object.userData.velocity.z * 0.1;
                    object.material.opacity = object.userData.life * 0.7;
                    object.scale.setScalar(object.userData.growth + (1 - object.userData.life) * 2);
                }
                // Handle fire rings
                else if (object.userData.expandSpeed) {
                    object.userData.scale += object.userData.expandSpeed * 0.1;
                    object.scale.setScalar(object.userData.scale);
                    object.material.opacity = object.userData.life;
                    
                    // Rotate rings
                    object.rotation.x += object.userData.rotateSpeed || 0;
                    object.rotation.y += object.userData.rotateSpeed || 0;
                    
                    // Move upward
                    object.position.y += 0.03;
                }
            }
        });
        
        if (!allDead) {
            requestAnimationFrame(animateExplosion);
        } else {
            scene.remove(explosionGroup);
            explosionGroup.children.forEach(object => {
                object.geometry.dispose();
                object.material.dispose();
            });
        }
    }
    
    animateExplosion();
}
