import type { ReactNode, SVGProps } from "react";

type IconProps = Omit<SVGProps<SVGSVGElement>, "d"> & { size?: number };

const Icon = ({ paths, size = 14, ...p }: IconProps & { paths: ReactNode }) => (
  <svg
    viewBox="0 0 24 24"
    width={size}
    height={size}
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    strokeLinejoin="round"
    {...p}
  >
    {paths}
  </svg>
);

export const I = {
  Chat: (p: IconProps) => (
    <Icon {...p} paths={<path d="M21 12a8 8 0 0 1-12.5 6.6L3 20l1.5-4.2A8 8 0 1 1 21 12Z" />} />
  ),
  Sliders: (p: IconProps) => (
    <Icon
      {...p}
      paths={
        <>
          <line x1="4" y1="6" x2="11" y2="6" />
          <line x1="15" y1="6" x2="20" y2="6" />
          <line x1="4" y1="12" x2="7" y2="12" />
          <line x1="11" y1="12" x2="20" y2="12" />
          <line x1="4" y1="18" x2="14" y2="18" />
          <line x1="18" y1="18" x2="20" y2="18" />
          <circle cx="13" cy="6" r="2" />
          <circle cx="9" cy="12" r="2" />
          <circle cx="16" cy="18" r="2" />
        </>
      }
    />
  ),
  Cpu: (p: IconProps) => (
    <Icon
      {...p}
      paths={
        <>
          <rect x="5" y="5" width="14" height="14" rx="2" />
          <rect x="9" y="9" width="6" height="6" />
          <path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3" />
        </>
      }
    />
  ),
  Download: (p: IconProps) => (
    <Icon
      {...p}
      paths={
        <>
          <path d="M12 3v12" />
          <path d="M7 11l5 4 5-4" />
          <path d="M5 21h14" />
        </>
      }
    />
  ),
  Cloud: (p: IconProps) => (
    <Icon
      {...p}
      paths={
        <>
          <path d="M7 18a4 4 0 0 1-.5-7.97A5.5 5.5 0 0 1 17 9.5a3.5 3.5 0 0 1 .5 6.96" />
          <path d="M12 12v6M9.5 15.5 12 18l2.5-2.5" />
        </>
      }
    />
  ),
  Trash: (p: IconProps) => (
    <Icon
      {...p}
      paths={
        <>
          <path d="M4 7h16" />
          <path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
          <path d="M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13" />
          <path d="M10 11v6M14 11v6" />
        </>
      }
    />
  ),
  Folder: (p: IconProps) => (
    <Icon
      {...p}
      paths={
        <path d="M3 6.5A2.5 2.5 0 0 1 5.5 4h3.4a2 2 0 0 1 1.6.8L11.7 6H19a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6.5Z" />
      }
    />
  ),
  Search: (p: IconProps) => (
    <Icon
      {...p}
      paths={
        <>
          <circle cx="11" cy="11" r="7" />
          <line x1="20" y1="20" x2="16.5" y2="16.5" />
        </>
      }
    />
  ),
  Bell: (p: IconProps) => (
    <Icon
      {...p}
      paths={
        <>
          <path d="M6 8a6 6 0 1 1 12 0c0 5 2 6 2 6H4s2-1 2-6Z" />
          <path d="M10 19a2 2 0 0 0 4 0" />
        </>
      }
    />
  ),
  Settings: (p: IconProps) => (
    <Icon
      {...p}
      paths={
        <>
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 14a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V20a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H4a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3h0a1.7 1.7 0 0 0 1-1.5V4a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5h0a1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9v0a1.7 1.7 0 0 0 1.5 1H20a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
        </>
      }
    />
  ),
  Chevron: (p: IconProps) => <Icon {...p} paths={<polyline points="6 9 12 15 18 9" />} />,
  ChevR: (p: IconProps) => <Icon {...p} paths={<polyline points="9 6 15 12 9 18" />} />,
  Plus: (p: IconProps) => (
    <Icon
      {...p}
      paths={
        <>
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </>
      }
    />
  ),
  Send: (p: IconProps) => <Icon {...p} paths={<path d="M3 11.5 20 4l-7.5 17-3-7Z" />} />,
  Copy: (p: IconProps) => (
    <Icon
      {...p}
      paths={
        <>
          <rect x="8" y="8" width="12" height="12" rx="2" />
          <path d="M4 16V6a2 2 0 0 1 2-2h10" />
        </>
      }
    />
  ),
  Play: (p: IconProps) => <Icon {...p} paths={<polygon points="6 4 20 12 6 20 6 4" />} />,
  Pause: (p: IconProps) => (
    <Icon
      {...p}
      paths={
        <>
          <rect x="6" y="5" width="4" height="14" />
          <rect x="14" y="5" width="4" height="14" />
        </>
      }
    />
  ),
  Stop: (p: IconProps) => (
    <Icon {...p} paths={<rect x="6" y="6" width="12" height="12" rx="1" />} />
  ),
  More: (p: IconProps) => (
    <Icon
      {...p}
      paths={
        <>
          <circle cx="5" cy="12" r="1.4" />
          <circle cx="12" cy="12" r="1.4" />
          <circle cx="19" cy="12" r="1.4" />
        </>
      }
    />
  ),
  Eject: (p: IconProps) => (
    <Icon
      {...p}
      paths={
        <>
          <polygon points="6 13 12 5 18 13" />
          <line x1="6" y1="18" x2="18" y2="18" />
        </>
      }
    />
  ),
  Spark: (p: IconProps) => (
    <Icon
      {...p}
      paths={<path d="M12 2v6M12 16v6M4 12h6M14 12h6M5 5l4 4M15 15l4 4M19 5l-4 4M9 15l-4 4" />}
    />
  ),
  Hardware: (p: IconProps) => (
    <Icon
      {...p}
      paths={
        <>
          <rect x="3" y="4" width="18" height="14" rx="2" />
          <path d="M7 20h10M9 18v2M15 18v2" />
        </>
      }
    />
  ),
  Bookmark: (p: IconProps) => <Icon {...p} paths={<path d="M6 4h12v17l-6-4-6 4Z" />} />,
  Pin: (p: IconProps) => (
    <Icon {...p} paths={<path d="M9 4h6l-1 6 4 3v2h-6v6l-1 1-1-1v-6H4v-2l4-3-1-6Z" />} />
  ),
  Terminal: (p: IconProps) => (
    <Icon
      {...p}
      paths={
        <>
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="M7 9l3 3-3 3M13 15h5" />
        </>
      }
    />
  ),
  History: (p: IconProps) => (
    <Icon
      {...p}
      paths={
        <>
          <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
          <path d="M3 3v5h5" />
          <path d="M12 7v5l3 2" />
        </>
      }
    />
  ),
  Brain: (p: IconProps) => (
    <Icon
      {...p}
      paths={
        <>
          <path d="M9 4a3 3 0 0 0-3 3v.5A3 3 0 0 0 4 10a3 3 0 0 0 1 2.2A3 3 0 0 0 5 16a3 3 0 0 0 3 3 3 3 0 0 0 3-2 3 3 0 0 0 3 2 3 3 0 0 0 3-3 3 3 0 0 0 0-3.8A3 3 0 0 0 18 10a3 3 0 0 0-2-2.5V7a3 3 0 0 0-3-3 3 3 0 0 0-2 .8A3 3 0 0 0 9 4Z" />
          <path d="M12 7v12" />
        </>
      }
    />
  ),
  Bolt: (p: IconProps) => (
    <Icon {...p} paths={<polygon points="13 2 4 14 11 14 9 22 20 10 13 10 13 2" />} />
  ),
  Refresh: (p: IconProps) => (
    <Icon
      {...p}
      paths={
        <>
          <polyline points="20 4 20 10 14 10" />
          <path d="M20 10A8 8 0 1 0 17 17" />
        </>
      }
    />
  ),
  X: (p: IconProps) => (
    <Icon
      {...p}
      paths={
        <>
          <line x1="6" y1="6" x2="18" y2="18" />
          <line x1="18" y1="6" x2="6" y2="18" />
        </>
      }
    />
  ),
  Check: (p: IconProps) => <Icon {...p} paths={<polyline points="5 12 10 17 19 7" />} />,
  Info: (p: IconProps) => (
    <Icon
      {...p}
      paths={
        <>
          <circle cx="12" cy="12" r="9" />
          <line x1="12" y1="11" x2="12" y2="17" />
          <circle cx="12" cy="8" r="0.6" fill="currentColor" />
        </>
      }
    />
  ),
  Thermo: (p: IconProps) => (
    <Icon {...p} paths={<path d="M14 14V4a2 2 0 1 0-4 0v10a4 4 0 1 0 4 0Z" />} />
  ),
  Mem: (p: IconProps) => (
    <Icon
      {...p}
      paths={
        <>
          <rect x="3" y="6" width="18" height="12" rx="1.5" />
          <path d="M7 6v12M11 6v12M15 6v12M19 6v12" />
        </>
      }
    />
  ),
  Gpu: (p: IconProps) => (
    <Icon
      {...p}
      paths={
        <>
          <rect x="3" y="6" width="18" height="11" rx="2" />
          <circle cx="9" cy="11.5" r="2.2" />
          <circle cx="16" cy="11.5" r="1.4" />
          <path d="M6 21h2M16 21h2M8 17v4M18 17v4" />
        </>
      }
    />
  ),
  Globe: (p: IconProps) => (
    <Icon
      {...p}
      paths={
        <>
          <circle cx="12" cy="12" r="9" />
          <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
        </>
      }
    />
  ),
  Lock: (p: IconProps) => (
    <Icon
      {...p}
      paths={
        <>
          <rect x="5" y="11" width="14" height="10" rx="2" />
          <path d="M8 11V7a4 4 0 1 1 8 0v4" />
        </>
      }
    />
  ),
  Star: (p: IconProps) => (
    <Icon
      {...p}
      paths={
        <polygon points="12 3 14.5 9 21 9.5 16 14 17.5 20.5 12 17 6.5 20.5 8 14 3 9.5 9.5 9 12 3" />
      }
    />
  ),
  Mic: (p: IconProps) => (
    <Icon
      {...p}
      paths={
        <>
          <rect x="9" y="3" width="6" height="11" rx="3" />
          <path d="M5 11a7 7 0 0 0 14 0" />
          <line x1="12" y1="18" x2="12" y2="21" />
          <line x1="8" y1="21" x2="16" y2="21" />
        </>
      }
    />
  ),
  Image: (p: IconProps) => (
    <Icon
      {...p}
      paths={
        <>
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <circle cx="8.5" cy="8.5" r="1.5" />
          <path d="m21 15-5-5L5 21" />
        </>
      }
    />
  ),
  Layers: (p: IconProps) => (
    <Icon
      {...p}
      paths={
        <>
          <path d="M12 3 2 8l10 5 10-5-10-5Z" />
          <path d="m2 13 10 5 10-5" />
        </>
      }
    />
  ),
} as const;

export type IconName = keyof typeof I;
