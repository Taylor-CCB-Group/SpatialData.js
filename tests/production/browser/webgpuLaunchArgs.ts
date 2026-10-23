// WebGPU is behind a flag in headless Chromium; the default config only sets up
// SwiftShader's WebGL path. On Linux (CI) SwiftShader's WebGPU device is created and
// draws one frame, then stalls without Vulkan-backed SwiftShader for presentation.
export const WEBGPU_LAUNCH_ARGS = [
  '--enable-unsafe-webgpu',
  '--use-gl=angle',
  '--use-angle=swiftshader',
  ...(process.platform === 'linux' ? ['--enable-features=Vulkan', '--use-vulkan=swiftshader'] : []),
];
