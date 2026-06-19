declare module "sound-play" {
  /** Plays an audio file to completion. volume is 0..1 (default 0.5). */
  export function play(filePath: string, volume?: number): Promise<void>;
  const _default: { play: typeof play };
  export default _default;
}
