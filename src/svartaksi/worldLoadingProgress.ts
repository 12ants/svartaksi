import type { WorldBuildDiagnostics } from '../world/threeWorld';

type ProgressDiagnostics = Pick<WorldBuildDiagnostics,
  'input' | 'finishedSlices' | 'estimatedSlices' | 'elapsedMs' | 'worstSliceMs'>;

export function worldBuildDetails(diagnostics: ProgressDiagnostics): string[] {
  const { input, finishedSlices, estimatedSlices, elapsedMs, worstSliceMs } = diagnostics;
  return [
    `Snapshot: ${input.buildings} buildings; ${input.roads} roads; ${input.water} water areas; ${input.parks} green areas; ${input.objects} street objects`,
    `Build: ${finishedSlices} work slices completed (initial estimate: ${estimatedSlices})`,
    `Build elapsed: ${(elapsedMs / 1000).toFixed(1)} s; slowest slice: ${worstSliceMs.toFixed(1)} ms`,
  ];
}
