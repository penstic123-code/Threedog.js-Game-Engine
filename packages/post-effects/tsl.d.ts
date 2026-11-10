// Types of @threedog/post-effects/tsl for code that imports it from the published package.
import type { PostEffect } from 'threedog';
import type { Box3, Light } from 'three';

/** Real-time bounced light (three's vxgi; hdr). Needs three's WebGPU backend; held off on low tier and on WebGPURenderer's WebGL2 backend, and describe().render.post says why. setup gets the VXGINode @experimental */
export function voxelGI(o?: { resolution?: number; bounds?: Box3; intensity?: number; occlusion?: number; setup?: (gi: any) => void; enabled?: boolean; order?: number; name?: string }): PostEffect;
/** Screen-space reflections (three's SSRNode, mirror mode; hdr): in proportion to metalness, only what is on screen. Held off on low tier; blurQuality and binaryRefine rebuild the chain. setup gets the SSRNode @experimental */
export function reflections(o?: { intensity?: number; maxDistance?: number; thickness?: number; quality?: number; resolutionScale?: number; blurQuality?: number; binaryRefine?: boolean; setup?: (ssr: any) => void; enabled?: boolean; order?: number; name?: string }): PostEffect;
/** Exposure that adapts like an eye (hdr, order 800, before tone mapping): log-average brightness measured on the GPU, eased toward key inside min..max; params change in place. WebGPURenderer only @experimental */
export function autoExposure(o?: { key?: number; speedUp?: number; speedDown?: number; min?: number; max?: number; enabled?: boolean; order?: number; name?: string }): PostEffect;
/** Temporal antialiasing (three's TRAANode; last in hdr): clears the dots of stochastic effects before it and replaces MSAA while on. WebGPURenderer only @experimental */
export function temporalAA(o?: { enabled?: boolean; order?: number; name?: string }): PostEffect;
/** Sun shafts through gaps, from the light's shadow map (three's GodraysNode; hdr). Best where most of the air is in shadow; open scenes turn to haze. WebGPURenderer only @experimental */
export function sunShafts(o?: { light?: Light; density?: number; maxDensity?: number; falloff?: number; color?: any; steps?: number; setup?: (rays: any) => void; enabled?: boolean; order?: number; name?: string }): PostEffect;
/** Lit air in a box: spot cones and point glows with shadows (three's VolumeNodeMaterial; hdr). Point and spot lights only, the sun does nothing here. WebGPURenderer only @experimental */
export function lightVolumes(o: { bounds: Box3; density?: number; steps?: number; scale?: number; blur?: number; scattering?: (tsl: any, at: { positionRay: any; density: any }) => any; enabled?: boolean; order?: number; name?: string }): PostEffect;
