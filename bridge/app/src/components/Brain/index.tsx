import { Canvas } from '@react-three/fiber';
import { Component, type ErrorInfo, type ReactNode } from 'react';
import type { BridgeEvent, ToolStartEvent } from '../../../../events.js';
import type { AgentStatus } from '../../hooks/useAgentStatus.js';
import { Core } from './Core.js';
import { Lightning } from './Lightning.js';
import { Orbitals } from './Orbital.js';
import { Particles } from './Particles.js';
import { PostprocessingEffects } from './Postprocessing.js';

// ErrorBoundary для Three.js
class BrainErrorBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { hasError: boolean }
> {
  constructor(props: { children: ReactNode; fallback: ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError(): { hasError: boolean } {
    return { hasError: true };
  }
  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[Brain] Three.js error:', error, info);
  }
  render(): ReactNode {
    return this.state.hasError ? this.props.fallback : this.props.children;
  }
}

const FALLBACK = (
  <div
    style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      height: '100%',
      color: 'rgba(217,119,87,0.5)',
      fontSize: 12,
    }}
  >
    [2] BRAIN — WebGL недоступен
  </div>
);

interface Props {
  events: BridgeEvent[];
  status: AgentStatus;
}

export function Brain({ events, status }: Props): ReactNode {
  const toolEvents = events.filter((e): e is ToolStartEvent => e.type === 'tool.start');

  return (
    <BrainErrorBoundary fallback={FALLBACK}>
      <Canvas
        camera={{ position: [0, 0, 6], fov: 60 }}
        style={{ width: '100%', height: '100%', background: 'transparent' }}
        gl={{ alpha: true, antialias: true }}
      >
        <ambientLight intensity={0.3} />
        <pointLight position={[5, 5, 5]} intensity={1} />
        <Core status={status} />
        <Orbitals />
        <Lightning toolEvents={toolEvents} />
        <Particles status={status} />
        <PostprocessingEffects />
      </Canvas>
    </BrainErrorBoundary>
  );
}
