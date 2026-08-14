import {
  DoubleSide,
  MeshBasicMaterial,
  MeshStandardMaterial,
  ShaderMaterial,
  Texture,
  Vector2,
  Vector3,
} from "three";
import type { FlipBookRenderSettings } from "../types";

export interface FoldShadingUniforms {
  uFoldPoint: { value: Vector2 };
  uFoldNormal: { value: Vector2 };
  uFoldBand: { value: number };
  uFoldStrength: { value: number };
}

/**
 * The ambient-occlusion band a standing curl throws on the page beside it.
 * A shadow map cannot produce this: at mid-turn nothing hangs over the
 * origin-side page, yet a real rolled sheet visibly darkens the paper next
 * to the fold. Injected into the resting-page material so the gradient hugs
 * the fold line and clips exactly to the paper.
 */
export function addFoldShading(
  material: MeshBasicMaterial | MeshStandardMaterial,
): FoldShadingUniforms {
  const uniforms: FoldShadingUniforms = {
    uFoldPoint: { value: new Vector2(0, 0) },
    uFoldNormal: { value: new Vector2(1, 0) },
    uFoldBand: { value: 0.3 },
    uFoldStrength: { value: 0 },
  };
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec2 vFoldWorld;")
      .replace(
        "#include <begin_vertex>",
        "#include <begin_vertex>\nvFoldWorld = (modelMatrix * vec4(position, 1.0)).xy;",
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        [
          "#include <common>",
          "varying vec2 vFoldWorld;",
          "uniform vec2 uFoldPoint;",
          "uniform vec2 uFoldNormal;",
          "uniform float uFoldBand;",
          "uniform float uFoldStrength;",
        ].join("\n"),
      )
      .replace(
        "#include <map_fragment>",
        [
          "#include <map_fragment>",
          "float foldDistance = dot(vFoldWorld - uFoldPoint, uFoldNormal);",
          "float foldShade = uFoldStrength *",
          "  (1.0 - smoothstep(0.0, uFoldBand, max(foldDistance, 0.0))) * step(0.0, foldDistance);",
          "diffuseColor.rgb *= 1.0 - foldShade;",
        ].join("\n"),
      );
  };
  material.customProgramCacheKey = () => "flipdocs-fold-shading";
  return uniforms;
}

export interface CurlMaterial extends ShaderMaterial {
  uniforms: {
    frontMap: { value: Texture };
    backMap: { value: Texture };
    paperColor: { value: Vector3 };
    ambientLight: { value: number };
    directionalLight: { value: number };
    foldContrast: { value: number };
    lightDirection: { value: Vector3 };
    sheen: { value: number };
    turnAmount: { value: number };
  };
}

/** Smooth, symmetric lighting strength with exact zero at both flat endpoints. */
export function turnShadingEnvelope(rawProgress: number): number {
  const progress = Math.max(0, Math.min(1, rawProgress));
  if (progress === 0 || progress === 1) return 0;
  const bend = Math.sin(Math.PI * progress);
  return bend * bend;
}

export function lightVector(settings: FlipBookRenderSettings): Vector3 {
  const angle = (settings.lightAngle * Math.PI) / 180;
  const elevation = Math.max(0.05, Math.min(1, settings.lightElevation));
  const horizontal = Math.sqrt(Math.max(0, 1 - elevation * elevation));
  return new Vector3(
    Math.cos(angle) * horizontal,
    Math.sin(angle) * horizontal,
    elevation,
  ).normalize();
}

export function createCurlMaterial(
  front: Texture,
  back: Texture,
  color: string,
  settings: FlipBookRenderSettings,
): CurlMaterial {
  const parsed = Number.parseInt(color.replace("#", ""), 16);
  const paper = new Vector3(
    ((parsed >> 16) & 255) / 255,
    ((parsed >> 8) & 255) / 255,
    (parsed & 255) / 255,
  );

  return new ShaderMaterial({
    side: DoubleSide,
    depthWrite: true,
    uniforms: {
      frontMap: { value: front },
      backMap: { value: back },
      paperColor: { value: paper },
      ambientLight: { value: settings.ambientLight },
      directionalLight: { value: settings.directionalLight },
      foldContrast: { value: settings.foldContrast },
      lightDirection: { value: lightVector(settings) },
      sheen: { value: settings.sheen },
      turnAmount: { value: 0 },
    },
    vertexShader: `
      varying vec2 vUv;
      varying vec3 vNormal;
      void main() {
        vUv = uv;
        vNormal = normalize(normalMatrix * normal);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform sampler2D frontMap;
      uniform sampler2D backMap;
      uniform vec3 paperColor;
      uniform float ambientLight;
      uniform float directionalLight;
      uniform float foldContrast;
      uniform vec3 lightDirection;
      uniform float sheen;
      uniform float turnAmount;
      varying vec2 vUv;
      varying vec3 vNormal;
      void main() {
        vec2 backUv = vec2(1.0 - vUv.x, vUv.y);
        vec4 ink = gl_FrontFacing ? texture2D(frontMap, vUv) : texture2D(backMap, backUv);
        vec3 normal = normalize(gl_FrontFacing ? vNormal : -vNormal);
        vec3 key = normalize(lightDirection);
        // Thin paper receives and transmits light from both sides. Normalize
        // against the flat sheet so starting a turn never darkens the page.
        float paperFacing = 0.65 + 0.35 * abs(dot(normal, key));
        float flatFacing = 0.65 + 0.35 * abs(key.z);
        float diffuse =
          (ambientLight + directionalLight * paperFacing) /
          max(0.01, ambientLight + directionalLight * flatFacing);
        float foldAmount = pow(1.0 - abs(normal.z), 1.35);
        float foldShade = 1.0 - foldContrast * foldAmount * turnAmount;
        float edgeFalloff = 1.0 - smoothstep(0.0, 0.08, min(vUv.x, 1.0 - vUv.x));
        float edgeShade = 1.0 - 0.06 * edgeFalloff * turnAmount;
        // Print may shade slightly darker while bending but never brighter
        // than its flat self beyond a whisper; paper is not a mirror.
        vec3 lit = ink.rgb * paperColor * min(diffuse, 1.03) * foldShade * edgeShade;
        // Glossy-paper sheen: a wide specular band that travels with the fold.
        // The orthographic camera looks down +z, so the half vector is fixed.
        // Suppress it on flat regions to keep resting print unchanged.
        vec3 half_ = normalize(key + vec3(0.0, 0.0, 1.0));
        float band = pow(max(0.0, abs(dot(normal, half_))), 48.0);
        float bend = smoothstep(0.03, 0.3, 1.0 - abs(normal.z)) * turnAmount;
        lit += sheen * 0.28 * band * bend;
        gl_FragColor = vec4(lit, ink.a);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  }) as CurlMaterial;
}
