import React from 'react';

import { toast } from '@/components/ui';
import { useUpdateStore } from '@/stores/useUpdateStore';
import { getDesktopBridge } from '@/lib/desktop';

export function useUpdatePolling() {
  const checkForUpdates = useUpdateStore((state) => state.checkForUpdates);
  const checkForUpdatesRef = React.useRef(checkForUpdates);

  React.useEffect(() => {
    checkForUpdatesRef.current = checkForUpdates;
  }, [checkForUpdates]);

  // Main process pushes 'openchamber:update-ready' once a release finished
  // downloading in the background; mirror it as an in-app toast so the user
  // can restart into the new version without opening settings.
  React.useEffect(() => {
    const bridge = getDesktopBridge();
    const listen = bridge?.listen;
    if (!listen) return;
    let unlisten: null | (() => void | Promise<void>) = null;
    let disposed = false;
    void (async () => {
      try {
        const stop = await listen('openchamber:update-ready', () => {
          const version = useUpdateStore.getState().info?.version;
          toast.success(
            version ? `Version ${version} is ready` : 'An update is ready',
            { description: 'Restart OpenChamber to apply the update.' },
          );
        });
        if (disposed) {
          void Promise.resolve(stop).then((fn) => fn?.());
          return;
        }
        unlisten = stop ?? null;
      } catch {
        // Desktop bridge unavailable (web runtime) — nothing to subscribe.
      }
    })();
    return () => {
      disposed = true;
      void Promise.resolve(unlisten).then((fn) => fn?.());
    };
  }, []);

  React.useEffect(() => {
    const initialDelayMs = 3000;
    const defaultIntervalMs = 60 * 60 * 1000;
    const minIntervalMs = 5 * 60 * 1000;
    const maxIntervalMs = 24 * 60 * 60 * 1000;
    let disposed = false;
    let timer: number | null = null;

    const clampIntervalMs = (seconds: number): number => {
      const ms = Math.round(seconds * 1000);
      return Math.max(minIntervalMs, Math.min(maxIntervalMs, ms));
    };

    const scheduleNext = (delayMs: number) => {
      if (disposed) return;
      timer = window.setTimeout(async () => {
        const suggestedSec = await checkForUpdatesRef.current();
        const nextDelay = typeof suggestedSec === 'number' && Number.isFinite(suggestedSec)
          ? clampIntervalMs(suggestedSec)
          : defaultIntervalMs;
        scheduleNext(nextDelay);
      }, delayMs);
    };

    scheduleNext(initialDelayMs);

    return () => {
      disposed = true;
      if (timer !== null) {
        window.clearTimeout(timer);
      }
    };
  }, []);
}
