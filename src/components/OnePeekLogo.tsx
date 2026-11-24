interface OnePeekLogoProps {
  size?: number;
  className?: string;
  collapsed?: boolean;
}

// Official OnePeek vector emblem supporting open (expanded) and sleeping (collapsed) eye states.
export function OnePeekLogo({ size = 20, className, collapsed = false }: OnePeekLogoProps) {
  if (collapsed) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 128 128"
        fill="none"
        className={className}
        aria-hidden="true"
      >
        <rect
          x={8}
          y={8}
          width={112}
          height={112}
          rx={28}
          fill="var(--logo-bg, #23262b)"
          stroke="color-mix(in srgb, var(--accent, #f5b700) 48%, #64748b)"
          strokeWidth={5.5}
        />
        <path
          d="M30 58 Q64 84 98 58"
          stroke="var(--logo-eye, #ececea)"
          strokeWidth={6}
          strokeLinecap="round"
        />
        <path
          d="M44 69 L39 80 M64 73 L64 85 M84 69 L89 80"
          stroke="var(--accent, #f5b700)"
          strokeWidth={4.5}
          strokeLinecap="round"
        />
      </svg>
    );
  }

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 128 128"
      fill="none"
      className={className}
      aria-hidden="true"
    >
      <rect
        x={8}
        y={8}
        width={112}
        height={112}
        rx={28}
        fill="var(--logo-bg, #23262b)"
        stroke="var(--accent, #f5b700)"
        strokeWidth={5.5}
      />
      <path
        d="M28 64 C42 40, 86 40, 100 64 C86 88, 42 88, 28 64 Z"
        stroke="var(--logo-eye, #ececea)"
        strokeWidth={6}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle cx={64} cy={64} r={14.5} fill="var(--accent, #f5b700)" />
      <circle cx={69} cy={59} r={4.8} fill="#ffffff" />
    </svg>
  );
}
