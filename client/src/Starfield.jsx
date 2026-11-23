import { useEffect, useRef } from 'react';

// Animated space background: drifting, twinkling stars with depth and a little mouse parallax.
export default function Starfield() {
  const ref = useRef(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas.getContext('2d');
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    let w, h, stars, mx = 0, my = 0, raf;

    const resize = () => {
      w = canvas.width = innerWidth;
      h = canvas.height = innerHeight;
      const count = Math.min(220, Math.floor((w * h) / 9000));
      stars = Array.from({ length: count }, () => ({
        x: Math.random() * w, y: Math.random() * h, z: Math.random() * 0.9 + 0.1, t: Math.random() * 6.28,
      }));
    };
    const onMove = (e) => { mx = e.clientX / w - 0.5; my = e.clientY / h - 0.5; };

    const draw = () => {
      ctx.clearRect(0, 0, w, h);
      for (const s of stars) {
        if (!reduce) {
          s.y += s.z * 0.25; s.x += s.z * 0.08; s.t += 0.02;
          if (s.y > h) s.y = 0;
          if (s.x > w) s.x = 0;
        }
        const x = s.x - mx * 40 * s.z;
        const y = s.y - my * 40 * s.z;
        const alpha = (0.35 + 0.55 * Math.abs(Math.sin(s.t))) * s.z;
        ctx.fillStyle = `rgba(${(180 + s.z * 60) | 0}, ${(200 + s.z * 40) | 0}, 255, ${alpha})`;
        ctx.beginPath();
        ctx.arc(x, y, s.z * 1.6, 0, 6.283);
        ctx.fill();
      }
      raf = requestAnimationFrame(draw);
    };

    resize();
    draw();
    addEventListener('resize', resize);
    addEventListener('mousemove', onMove);
    return () => {
      cancelAnimationFrame(raf);
      removeEventListener('resize', resize);
      removeEventListener('mousemove', onMove);
    };
  }, []);

  return <canvas id="stars" ref={ref} aria-hidden="true" />;
}
