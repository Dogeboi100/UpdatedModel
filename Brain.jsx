import { useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { ImprovedNoise } from 'three/examples/jsm/math/ImprovedNoise.js'
import { useReducedMotion } from 'framer-motion'

/* ------------------------------------------------------------------ */
/*  Geometry — built once, on the CPU, at mount                        */
/* ------------------------------------------------------------------ */

// Ridged noise: turns smooth Perlin into connected gyri-like crests
function ridge(noise, v, frequency, offset) {
  const n = noise.noise(
    v.x * frequency + offset,
    v.y * frequency + offset * 0.31,
    v.z * frequency,
  )
  return 1 - Math.min(1, Math.abs(n) * 1.9)
}

function buildHemisphere(side, noise) {
  // mergeVertices → indexed geometry with shared verts → smooth normals
  const geom = mergeVertices(new THREE.IcosahedronGeometry(1, 5))
  const pos = geom.attributes.position
  const v = new THREE.Vector3()

  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).normalize()

    // 1 on the lateral (outer) face, 0 on the medial wall facing the fissure
    const lateral = THREE.MathUtils.smoothstep(v.x * side, -0.6, 0.0)
    let xScale = THREE.MathUtils.lerp(0.12, 0.6, lateral)

    // the hemisphere narrows toward the frontal pole (+z)
    xScale *= 1 - 0.16 * THREE.MathUtils.smoothstep(v.z, 0.25, 1.0)

    const x = v.x * xScale
    let y = v.y * 0.72
    const z = v.z

    // flatten the underside slightly (temporal base)
    y *= 1 - 0.14 * THREE.MathUtils.smoothstep(-v.y, 0.15, 1.0)

    // cortical folds — three octaves of ridged noise, offset per side
    // so the two hemispheres are naturally asymmetric
    const o = side * 9.73
    const folds =
      ridge(noise, v, 2.3, o) * 0.55 +
      ridge(noise, v, 4.7, o + 11.3) * 0.33 +
      ridge(noise, v, 8.2, o + 23.7) * 0.12
    const swell = noise.noise(v.x * 1.1 + o, v.y * 1.1, v.z * 1.1)

    const relief = 0.92 + folds * 0.16 + swell * 0.035
    // suppress relief on the medial wall so the fissure stays a crisp seam
    const r = THREE.MathUtils.lerp(0.965, relief, 0.2 + lateral * 0.8)

    pos.setXYZ(i, x * r, y * r, z * r)
  }

  geom.computeVertexNormals()
  return geom
}

function buildCerebellum(noise) {
  const geom = mergeVertices(new THREE.IcosahedronGeometry(1, 4))
  const pos = geom.attributes.position
  const v = new THREE.Vector3()

  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).normalize()
    // folia: tight horizontal laminae
    const folia =
      1 - Math.min(1, Math.abs(noise.noise(v.x * 2.2, v.y * 16.0 + 53.1, v.z * 2.2)) * 1.9)
    const swell = noise.noise(v.x * 2.6 + 7.7, v.y * 2.6, v.z * 2.6)
    const r = 0.94 + folia * 0.085 + swell * 0.04
    pos.setXYZ(i, v.x * 0.46 * r, v.y * 0.27 * r, v.z * 0.36 * r)
  }

  geom.computeVertexNormals()
  return geom
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

const NO_RAYCAST = () => null

export default function Brain({ onHoverChange }) {
  const group = useRef()
  const prefersReduced = useReducedMotion()

  const geometries = useMemo(() => {
    const noise = new ImprovedNoise()
    return {
      right: buildHemisphere(1, noise),
      left: buildHemisphere(-1, noise),
      cerebellum: buildCerebellum(noise),
      stem: new THREE.CylinderGeometry(0.115, 0.16, 0.55, 28, 6),
      // low-poly invisible hit-volume — keeps pointer raycasts cheap
      proxy: new THREE.SphereGeometry(1, 24, 18),
    }
  }, [])

  const uniforms = useMemo(
    () => ({
      uPointer: { value: new THREE.Vector3(0, 0, 100) }, // world-space lens centre
      uLens: { value: 0 }, //                              0 → off, 1 → fully engaged
      uRadius: { value: 0.52 }, //                          lens footprint (world units)
      uBulge: { value: 0.17 }, //                           local magnification amplitude
      uAccent: { value: new THREE.Color('#22D3EE') },
    }),
    [],
  )

  // MeshStandardMaterial patched with a localized "lens" displacement:
  // vertices inside uRadius of the cursor's surface point are pushed
  // outward along their normals (a true local scale-up of the mesh),
  // while the fragment stage adds a cyan focus glow + fresnel rim.
  const material = useMemo(() => {
    const mat = new THREE.MeshStandardMaterial({
      color: '#9FB6CE',
      roughness: 0.42,
      metalness: 0.16,
    })

    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms)

      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
           uniform vec3 uPointer;
           uniform float uLens;
           uniform float uRadius;
           uniform float uBulge;
           varying float vLens;`,
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
           vec4 lensWorld = modelMatrix * vec4( transformed, 1.0 );
           float lensDist = distance( lensWorld.xyz, uPointer );
           float lensInfluence = smoothstep( uRadius, uRadius * 0.12, lensDist ) * uLens;
           vLens = lensInfluence;
           transformed += normal * lensInfluence * uBulge;`,
        )

      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
           uniform vec3 uAccent;
           varying float vLens;`,
        )
        .replace(
          '#include <emissivemap_fragment>',
          `#include <emissivemap_fragment>
           float lensFresnel = pow( 1.0 - saturate( dot( normalize( normal ), normalize( vViewPosition ) ) ), 2.6 );
           totalEmissiveRadiance += uAccent * ( lensFresnel * 0.16 + vLens * 0.7 );`,
        )
    }

    mat.customProgramCacheKey = () => 'synaptiq-cortex-lens'
    return mat
  }, [uniforms])

  // GPU/CPU hygiene on unmount
  useEffect(
    () => () => {
      Object.values(geometries).forEach((g) => g.dispose())
      material.dispose()
    },
    [geometries, material],
  )

  // Pointer state lives in a ref → zero React re-renders per mousemove
  const lens = useRef({ target: new THREE.Vector3(0, 0, 100), strength: 0 })

  const handleMove = (e) => lens.current.target.copy(e.point)
  const handleOver = () => {
    lens.current.strength = 1
    onHoverChange?.(true)
  }
  const handleOut = () => {
    lens.current.strength = 0
    onHoverChange?.(false)
  }

  useFrame(({ clock, pointer }, delta) => {
    const dt = Math.min(delta, 1 / 30)

    // frame-rate-independent critical damping
    uniforms.uPointer.value.lerp(lens.current.target, 1 - Math.exp(-dt * 14))
    uniforms.uLens.value += (lens.current.strength - uniforms.uLens.value) * (1 - Math.exp(-dt * 9))

    const g = group.current
    if (!g) return

    const t = clock.elapsedTime
    const amp = prefersReduced ? 0 : 1

    // ambient drift + gentle cursor parallax, both damped
    const targetY = -0.42 + Math.sin(t * 0.22) * 0.15 * amp + pointer.x * 0.2 * amp
    const targetX = 0.12 + Math.cos(t * 0.17) * 0.06 * amp - pointer.y * 0.14 * amp
    const k = 1 - Math.exp(-dt * 4)
    g.rotation.y += (targetY - g.rotation.y) * k
    g.rotation.x += (targetX - g.rotation.x) * k
    g.position.y = Math.sin(t * 0.55) * 0.045 * amp
  })

  return (
    <group ref={group} scale={1.18} rotation={[0.12, -0.42, 0]}>
      <mesh geometry={geometries.right} material={material} position={[0.125, 0, 0]} raycast={NO_RAYCAST} />
      <mesh geometry={geometries.left} material={material} position={[-0.125, 0, 0]} raycast={NO_RAYCAST} />
      <mesh
        geometry={geometries.cerebellum}
        material={material}
        position={[0, -0.42, -0.66]}
        raycast={NO_RAYCAST}
      />
      <mesh
        geometry={geometries.stem}
        material={material}
        position={[0, -0.52, -0.22]}
        rotation={[0.45, 0, 0]}
        raycast={NO_RAYCAST}
      />

      {/* Invisible ellipsoid hit-volume: receives all pointer events.
          three's Raycaster ignores `visible`, so events still fire,
          but per-move intersection cost stays O(hundreds of tris). */}
      <mesh
        geometry={geometries.proxy}
        visible={false}
        scale={[0.78, 0.82, 1.12]}
        position={[0, -0.04, -0.05]}
        onPointerMove={handleMove}
        onPointerOver={handleOver}
        onPointerOut={handleOut}
      />
    </group>
  )
}
