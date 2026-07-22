import { Bloom, ChromaticAberration, EffectComposer, Vignette } from '@react-three/postprocessing';
import type { ReactNode } from 'react';
import { Vector2 } from 'three';

export function PostprocessingEffects(): ReactNode {
  return (
    <EffectComposer>
      <Bloom intensity={0.4} luminanceThreshold={0.8} luminanceSmoothing={0.9} />
      <Vignette darkness={0.5} />
      <ChromaticAberration offset={new Vector2(0.001, 0.001)} />
    </EffectComposer>
  );
}
