import type { ReactNode } from 'react';

/**
 * Pawbook's icon set: small inline SVGs on one consistent system — 24px grid,
 * 1.75 stroke, round caps/joins, `currentColor` — so every icon inherits the
 * text color of its context. Decorative by default (`aria-hidden`); pair with
 * visible text or an aria-label on the interactive parent.
 */
export type IconProps = { size?: number };

function Svg({ size = 20, children }: { size?: number; children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export function IconPaw({ size }: IconProps) {
  return (
    <Svg size={size}>
      <circle cx="11" cy="4" r="2" />
      <circle cx="18" cy="8" r="2" />
      <circle cx="20" cy="16" r="2" />
      <path d="M9 10a5 5 0 0 1 5 5v3.5a3.5 3.5 0 0 1-6.84 1.045Q6.52 17.48 4.46 16.84A3.5 3.5 0 0 1 5.5 10Z" />
    </Svg>
  );
}

export function IconBed({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M2 20v-8a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v8" />
      <path d="M4 10V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v4" />
      <path d="M12 4v6" />
      <path d="M2 18h20" />
    </Svg>
  );
}

export function IconSun({ size }: IconProps) {
  return (
    <Svg size={size}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2" />
      <path d="M12 20v2" />
      <path d="m4.93 4.93 1.41 1.41" />
      <path d="m17.66 17.66 1.41 1.41" />
      <path d="M2 12h2" />
      <path d="M20 12h2" />
      <path d="m6.34 17.66-1.41 1.41" />
      <path d="m19.07 4.93-1.41 1.41" />
    </Svg>
  );
}

export function IconHome({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <path d="M9 22V12h6v10" />
    </Svg>
  );
}

export function IconClipboardCheck({ size }: IconProps) {
  return (
    <Svg size={size}>
      <rect x="8" y="2" width="8" height="4" rx="1" />
      <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
      <path d="m9 14 2 2 4-4" />
    </Svg>
  );
}

export function IconCalendar({ size }: IconProps) {
  return (
    <Svg size={size}>
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <path d="M16 2v4" />
      <path d="M8 2v4" />
      <path d="M3 10h18" />
    </Svg>
  );
}

export function IconUsers({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </Svg>
  );
}

export function IconPlug({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M12 22v-5" />
      <path d="M9 8V2" />
      <path d="M15 8V2" />
      <path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z" />
    </Svg>
  );
}

export function IconCode({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path d="m16 18 6-6-6-6" />
      <path d="m8 6-6 6 6 6" />
    </Svg>
  );
}

export function IconTag({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z" />
      <circle cx="7.5" cy="7.5" r="0.5" fill="currentColor" />
    </Svg>
  );
}

export function IconStore({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M4 10.5V21h16V10.5" />
      <path d="M3 21h18" />
      <path d="M4.5 3h15l1.5 4.5H3z" />
      <path d="M3 7.5a3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0 6 0" />
      <path d="M10 21v-5h4v5" />
    </Svg>
  );
}

export function IconChartBar({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M3 3v16a2 2 0 0 0 2 2h16" />
      <path d="M7 16v-3" />
      <path d="M12 16v-6" />
      <path d="M17 16v-9" />
    </Svg>
  );
}

export function IconChevronLeft({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path d="m15 18-6-6 6-6" />
    </Svg>
  );
}

export function IconChevronRight({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path d="m9 18 6-6-6-6" />
    </Svg>
  );
}

export function IconCheck({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M20 6 9 17l-5-5" />
    </Svg>
  );
}
