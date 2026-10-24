import { useEffect, useState } from 'react';

/**
 * True while the primary pointer is coarse (a touch screen).
 *
 * The shell's extra-keys row shows for touch input regardless of viewport
 * width — a landscape phone or a tablet is `md:`-wide but still has no
 * physical keys — and stays hidden for mouse/trackpad users, who have a real
 * keyboard attached.
 */
export function useIsTouchDevice(): boolean {
  const [isTouchDevice, setIsTouchDevice] = useState(() => {
    if (typeof window === 'undefined' || !window.matchMedia) {
      return false;
    }
    return window.matchMedia('(pointer: coarse)').matches;
  });

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) {
      return undefined;
    }

    const query = window.matchMedia('(pointer: coarse)');
    const update = () => setIsTouchDevice(query.matches);
    update();

    if (typeof query.addEventListener === 'function') {
      query.addEventListener('change', update);
      return () => query.removeEventListener('change', update);
    }

    query.addListener(update);
    return () => query.removeListener(update);
  }, []);

  return isTouchDevice;
}
