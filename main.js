console.clear();

if (!navigator.gpu) {
    console.error("WebGPU not supported in this browser.");
    throw new Error("WebGPU not supported.");
}

async function initWebGPU() {
    const canvas = document.querySelector('canvas');
    const adapter = await navigator.gpu.requestAdapter();
    const device = await adapter.requestDevice();
    const context = canvas.getContext('webgpu');

    // Resize canvas to fit the window
  const dpi=2;
    const resizeCanvas = () => {
        canvas.width = window.innerWidth*dpi;
        canvas.height = window.innerHeight*dpi;
    };
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);

    // Configure the canvas context
    const format = navigator.gpu.getPreferredCanvasFormat();
    context.configure({
        device: device,
        format: format,
        alphaMode: 'premultiplied'
    });

    return { device, context, format };
}
function createRenderLoop(device, context, positionBuffer, velocityBuffer, timeBuffer) {
    const shaderModule = createShaderModule(device);
    const pipeline = createRenderPipeline(device, shaderModule);

    const { computePipeline, bindGroup } = initComputePass(device, positionBuffer, velocityBuffer, timeBuffer);

    const renderBindGroupLayout = pipeline.getBindGroupLayout(0);
    const renderBindGroup = device.createBindGroup({
        layout: renderBindGroupLayout,
        entries: [{ binding: 0, resource: { buffer: positionBuffer } }],
    });
  
  let startTime = performance.now();

    const render = () => {
      const elapsedTime = (performance.now()-startTime)*.0001;
      device.queue.writeBuffer(timeBuffer, 0, new Float32Array([elapsedTime]));
      
        const commandEncoder = device.createCommandEncoder();

        // Compute Pass
        const computePass = commandEncoder.beginComputePass();
        computePass.setPipeline(computePipeline);
        computePass.setBindGroup(0, bindGroup);
        computePass.dispatchWorkgroups(Math.ceil(NUM_PARTICLES / 64));
        computePass.end();

        // Render Pass
        const textureView = context.getCurrentTexture().createView();
        const renderPassDescriptor = {
            colorAttachments: [{
                view: textureView,
                clearValue: { r: 0, g: 0, b: 0, a: 1 },
                loadOp: 'clear',
                storeOp: 'store',
            }],
        };

        const renderPass = commandEncoder.beginRenderPass(renderPassDescriptor);
        renderPass.setPipeline(pipeline);
        renderPass.setBindGroup(0, renderBindGroup);
        renderPass.draw(NUM_PARTICLES);
        renderPass.end();

        device.queue.submit([commandEncoder.finish()]);
        requestAnimationFrame(render);
    };

    render();
}


const NUM_PARTICLES = 2000000;
function generateParticleData() {
    const positions = new Float32Array(NUM_PARTICLES * 3);
    const velocities = new Float32Array(NUM_PARTICLES * 3);

    for (let i = 0; i < NUM_PARTICLES; i++) {
        // Random position in a cube [-1, 1]
        positions[i * 3 + 0] = Math.random() * 1 - .5; // x
        positions[i * 3 + 1] = Math.random() * 1 - .5; // y
        positions[i * 3 + 2] = Math.random() * 1 - .5; // z

        // Random velocity in range [-0.1, 0.1]
        velocities[i * 3 + 0] = Math.random() * 0.2 - 0.1; // vx
        velocities[i * 3 + 1] = Math.random() * 0.2 - 0.1; // vy
        velocities[i * 3 + 2] = Math.random() * 0.2 - 0.1; // vz
    }

    return { positions, velocities };
}
function createParticleBuffers(device, positions, velocities) {
    // Create position buffer
    const positionBuffer = device.createBuffer({
        size: positions.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.STORAGE,
        mappedAtCreation: true,
    });
    new Float32Array(positionBuffer.getMappedRange()).set(positions);
    positionBuffer.unmap();

    // Create velocity buffer
    const velocityBuffer = device.createBuffer({
        size: velocities.byteLength,
        usage: GPUBufferUsage.STORAGE,
        mappedAtCreation: true,
    });
    new Float32Array(velocityBuffer.getMappedRange()).set(velocities);
    velocityBuffer.unmap();

    return { positionBuffer, velocityBuffer };
}
async function initParticleSystem(device) {
    const { positions, velocities } = generateParticleData();
    const buffers = createParticleBuffers(device, positions, velocities);
    return buffers;
}

const shaderCode = `
    @group(0) @binding(0) var<storage, read> particlePositions: array<vec3<f32>>;
    
    struct VertexOutput {
      @builtin(position) position: vec4<f32>,
      @location(0) pos: vec3<f32>
    }

    @vertex
    fn vmain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
      var opt: VertexOutput;
        let position = particlePositions[vertexIndex];
        opt.position = vec4<f32>(position, 1.0);
        opt.pos = position;
        return opt;
    }

    @fragment
    fn fmain(input: VertexOutput) -> @location(0) vec4<f32> {
        return vec4<f32>(1, 1, 1, 1);
    }
`;
function createShaderModule(device) {
    return device.createShaderModule({
        code: shaderCode,
    });
}
function createRenderPipeline(device, shaderModule) {
    return device.createRenderPipeline({
        layout: 'auto',
        vertex: {
            module: shaderModule,
            entryPoint: 'vmain', // Vertex shader entry point
        },
        fragment: {
            module: shaderModule,
            entryPoint: 'fmain', // Fragment shader entry point
            targets: [{
                format: 'bgra8unorm',
              blend: {
                color: {
                  srcFactor: 'src-alpha',
                  dstFactor: 'one-minus-src-alpha',
                  operations: 'add'
                },
                alpha: {
                  srcFactor: 'one',
                  dstFactor: 'one-minus-src-alpha',
                  operations: 'add'
                }
              }
            }],
        },
        primitive: {
            topology: 'point-list', // Render particles as points
        },
    });
}

const computeShaderCode = `
    @group(0) @binding(0) var<storage, read_write> particlePositions: array<vec3<f32>>;
    @group(0) @binding(1) var<storage, read_write> particleVelocities: array<vec3<f32>>;
    @group(0) @binding(2) var<uniform> time: f32;
    
    
    // https://www.pcg-random.org/
fn pcg(n: u32) -> u32 {
    var h = n * 747796405u + 2891336453u;
    h = ((h >> ((h >> 28u) + 4u)) ^ h) * 277803737u;
    return (h >> 22u) ^ h;
}

fn pcg2d(p: vec2u) -> vec2u {
    var v = p * 1664525u + 1013904223u;
    v.x += v.y * 1664525u; v.y += v.x * 1664525u;
    v ^= v >> vec2u(16u);
    v.x += v.y * 1664525u; v.y += v.x * 1664525u;
    v ^= v >> vec2u(16u);
    return v;
}

// http://www.jcgt.org/published/0009/03/02/
fn pcg3d(p: vec3u) -> vec3u {
    var v = p * 1664525u + 1013904223u;
    v.x += v.y*v.z; v.y += v.z*v.x; v.z += v.x*v.y;
    v ^= v >> vec3u(16u);
    v.x += v.y*v.z; v.y += v.z*v.x; v.z += v.x*v.y;
    return v;
}

// http://www.jcgt.org/published/0009/03/02/
fn pcg4d(p: vec4u) -> vec4u {
    var v = p * 1664525u + 1013904223u;
    v.x += v.y*v.w; v.y += v.z*v.x; v.z += v.x*v.y; v.w += v.y*v.z;
    v ^= v >> vec4u(16u);
    v.x += v.y*v.w; v.y += v.z*v.x; v.z += v.x*v.y; v.w += v.y*v.z;
    return v;
}
fn rand33(f: vec3f) -> vec3f { return vec3f(pcg3d(bitcast<vec3u>(f))) / f32(0xffffffff); }
    
// MIT License. © Stefan Gustavson, Munrocket
//
fn permute4(x: vec4f) -> vec4f { return ((x * 34. + 1.) * x) % vec4f(289.); }
fn taylorInvSqrt4(r: vec4f) -> vec4f { return 1.79284291400159 - 0.85373472095314 * r; }
fn fade3(t: vec3f) -> vec3f { return t * t * t * (t * (t * 6. - 15.) + 10.); }

fn perlinNoise3(P: vec3f) -> f32 {
    var Pi0 : vec3f = floor(P); // Integer part for indexing
    var Pi1 : vec3f = Pi0 + vec3f(1.); // Integer part + 1
    Pi0 = Pi0 % vec3f(289.);
    Pi1 = Pi1 % vec3f(289.);
    let Pf0 = fract(P); // Fractional part for interpolation
    let Pf1 = Pf0 - vec3f(1.); // Fractional part - 1.
    let ix = vec4f(Pi0.x, Pi1.x, Pi0.x, Pi1.x);
    let iy = vec4f(Pi0.yy, Pi1.yy);
    let iz0 = Pi0.zzzz;
    let iz1 = Pi1.zzzz;

    let ixy = permute4(permute4(ix) + iy);
    let ixy0 = permute4(ixy + iz0);
    let ixy1 = permute4(ixy + iz1);

    var gx0: vec4f = ixy0 / 7.;
    var gy0: vec4f = fract(floor(gx0) / 7.) - 0.5;
    gx0 = fract(gx0);
    var gz0: vec4f = vec4f(0.5) - abs(gx0) - abs(gy0);
    var sz0: vec4f = step(gz0, vec4f(0.));
    gx0 = gx0 + sz0 * (step(vec4f(0.), gx0) - 0.5);
    gy0 = gy0 + sz0 * (step(vec4f(0.), gy0) - 0.5);

    var gx1: vec4f = ixy1 / 7.;
    var gy1: vec4f = fract(floor(gx1) / 7.) - 0.5;
    gx1 = fract(gx1);
    var gz1: vec4f = vec4f(0.5) - abs(gx1) - abs(gy1);
    var sz1: vec4f = step(gz1, vec4f(0.));
    gx1 = gx1 - sz1 * (step(vec4f(0.), gx1) - 0.5);
    gy1 = gy1 - sz1 * (step(vec4f(0.), gy1) - 0.5);

    var g000: vec3f = vec3f(gx0.x, gy0.x, gz0.x);
    var g100: vec3f = vec3f(gx0.y, gy0.y, gz0.y);
    var g010: vec3f = vec3f(gx0.z, gy0.z, gz0.z);
    var g110: vec3f = vec3f(gx0.w, gy0.w, gz0.w);
    var g001: vec3f = vec3f(gx1.x, gy1.x, gz1.x);
    var g101: vec3f = vec3f(gx1.y, gy1.y, gz1.y);
    var g011: vec3f = vec3f(gx1.z, gy1.z, gz1.z);
    var g111: vec3f = vec3f(gx1.w, gy1.w, gz1.w);

    let norm0 = taylorInvSqrt4(
        vec4f(dot(g000, g000), dot(g010, g010), dot(g100, g100), dot(g110, g110)));
    g000 = g000 * norm0.x;
    g010 = g010 * norm0.y;
    g100 = g100 * norm0.z;
    g110 = g110 * norm0.w;
    let norm1 = taylorInvSqrt4(
        vec4f(dot(g001, g001), dot(g011, g011), dot(g101, g101), dot(g111, g111)));
    g001 = g001 * norm1.x;
    g011 = g011 * norm1.y;
    g101 = g101 * norm1.z;
    g111 = g111 * norm1.w;

    let n000 = dot(g000, Pf0);
    let n100 = dot(g100, vec3f(Pf1.x, Pf0.yz));
    let n010 = dot(g010, vec3f(Pf0.x, Pf1.y, Pf0.z));
    let n110 = dot(g110, vec3f(Pf1.xy, Pf0.z));
    let n001 = dot(g001, vec3f(Pf0.xy, Pf1.z));
    let n101 = dot(g101, vec3f(Pf1.x, Pf0.y, Pf1.z));
    let n011 = dot(g011, vec3f(Pf0.x, Pf1.yz));
    let n111 = dot(g111, Pf1);

    var fade_xyz: vec3f = fade3(Pf0);
    let temp = vec4f(f32(fade_xyz.z)); // simplify after chrome bug fix
    let n_z = mix(vec4f(n000, n100, n010, n110), vec4f(n001, n101, n011, n111), temp);
    let n_yz = mix(n_z.xy, n_z.zw, vec2f(f32(fade_xyz.y))); // simplify after chrome bug fix
    let n_xyz = mix(n_yz.x, n_yz.y, fade_xyz.x);
    return 2.2 * n_xyz;
}



    @compute @workgroup_size(64)
    fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
        let index = global_id.x;
        if (index >= arrayLength(&particlePositions)) {
            return;
        }
        
        let ro = vec3<f32>(rand33(particlePositions[index]*1024+vec3<f32>(global_id)))*.2-.1;
        let offset = vec3<f32>(time*5.,0,0)+ro;
        
        
        particleVelocities[index].x += perlinNoise3(particlePositions[index]*(3.+cos(time))+offset)*.2;
        particleVelocities[index].y += perlinNoise3(particlePositions[index]*2.+10.-offset)*.2;
        particleVelocities[index] *= .9;
        particleVelocities[index] = clamp(particleVelocities[index], vec3<f32>(-1), vec3<f32>(1));

        particlePositions[index] += particleVelocities[index] * 0.01 + ro*.05;

        for (var i = 0; i < 3; i++) {
            if (particlePositions[index][i] < -1.1) {
                particlePositions[index][i] = 1.0;
                particleVelocities[index][i] *= -1.0; // Reverse direction
            }
            if (particlePositions[index][i] > 1.1) {
                particlePositions[index][i] = -1.0;
                particleVelocities[index][i] *= -1.0; // Reverse direction
            }
        }
    }
`;
function createComputePipeline(device, computeShaderModule) {
    return device.createComputePipeline({
        layout: 'auto',
        compute: {
            module: computeShaderModule,
            entryPoint: 'main',
        },
    });
}
function initComputePass(device, positionBuffer, velocityBuffer, timeBuffer) {
    const computeShaderModule = device.createShaderModule({
        code: computeShaderCode,
    });

    const computePipeline = createComputePipeline(device, computeShaderModule);

    const bindGroupLayout = computePipeline.getBindGroupLayout(0);
    const bindGroup = device.createBindGroup({
        layout: bindGroupLayout,
        entries: [
            { binding: 0, resource: { buffer: positionBuffer } },
            { binding: 1, resource: { buffer: velocityBuffer } },
            { binding: 2, resource: { buffer: timeBuffer } }
        ],
    });

    return { computePipeline, bindGroup };
}

function createTimeBuffer(device) {
  const timeBuffer = device.createBuffer({
    size: 4,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
  });
  return timeBuffer;
}


(async () => {
    const { device, context } = await initWebGPU();
    const { positionBuffer, velocityBuffer } = await initParticleSystem(device);
  const timeBuffer = createTimeBuffer(device);
    createRenderLoop(device, context, positionBuffer, velocityBuffer, timeBuffer);
})();

