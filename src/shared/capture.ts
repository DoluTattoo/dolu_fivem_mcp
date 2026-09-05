export const CAPTURE_VERSION = 1;

export interface GameCaptureOptions {
  maxWidth: number;
  format: "jpeg" | "png";
  quality: number;
  timeoutMs: number;
  maxBytes: number;
  overlay?: string;
}

export interface GameCaptureImage {
  data: string;
  mimeType: "image/jpeg" | "image/png";
  width: number;
  height: number;
  capturedAt: string;
}

export interface GameCaptureBridge {
  version: number;
  capture(options: GameCaptureOptions): Promise<GameCaptureImage>;
}
