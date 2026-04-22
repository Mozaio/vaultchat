import { useCallback, useRef, useState } from "react";

export type VoiceRecording = {
  dataUrl: string;
  mime: string;
  durationMs: number;
};

export function useVoiceRecorder() {
  const [recording, setRecording] = useState(false);
  const recRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startRef = useRef<number>(0);
  const streamRef = useRef<MediaStream | null>(null);

  const start = useCallback(async (): Promise<boolean> => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";
      const rec = new MediaRecorder(stream, { mimeType: mime });
      chunksRef.current = [];
      rec.ondataavailable = (ev) => {
        if (ev.data.size > 0) chunksRef.current.push(ev.data);
      };
      rec.start(100);
      recRef.current = rec;
      startRef.current = Date.now();
      setRecording(true);
      return true;
    } catch {
      setRecording(false);
      return false;
    }
  }, []);

  const stop = useCallback(async (): Promise<VoiceRecording | null> => {
    const rec = recRef.current;
    if (!rec) return null;
    const finished = new Promise<VoiceRecording | null>((resolve) => {
      rec.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: rec.mimeType });
        const reader = new FileReader();
        reader.onload = () => {
          resolve({
            dataUrl: String(reader.result ?? ""),
            mime: rec.mimeType || "audio/webm",
            durationMs: Date.now() - startRef.current,
          });
        };
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(blob);
      };
    });
    rec.stop();
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    recRef.current = null;
    setRecording(false);
    return finished;
  }, []);

  const cancel = useCallback(() => {
    const rec = recRef.current;
    if (rec) {
      rec.onstop = null;
      try {
        rec.stop();
      } catch {
        /* ignore */
      }
    }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    recRef.current = null;
    setRecording(false);
  }, []);

  return { recording, start, stop, cancel };
}
