import React from 'react';

// Minimal inline icon set (stroke-based, inherits currentColor) so the app has
// no icon-font dependency.
function Icon({ path, className = 'h-4 w-4', fill = 'none', stroke = 'currentColor', ...rest }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill={fill}
      stroke={stroke}
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {path}
    </svg>
  );
}

export const ChatIcon = (p) => (
  <Icon {...p} path={<path d="M21 12a8 8 0 01-8 8H7l-4 3v-6.5A8 8 0 0113 4a8 8 0 018 8z" />} />
);
export const DocIcon = (p) => (
  <Icon {...p} path={<><path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z" /><path d="M14 3v5h5" /></>} />
);
export const SearchIcon = (p) => (
  <Icon {...p} path={<><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></>} />
);
export const SettingsIcon = (p) => (
  <Icon {...p} path={<><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z" /></>} />
);
export const PlusIcon = (p) => <Icon {...p} path={<path d="M12 5v14M5 12h14" />} />;
export const TrashIcon = (p) => (
  <Icon {...p} path={<><path d="M3 6h18" /><path d="M8 6V4a1 1 0 011-1h6a1 1 0 011 1v2" /><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" /></>} />
);
export const UploadIcon = (p) => (
  <Icon {...p} path={<><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" /><path d="M17 8l-5-5-5 5" /><path d="M12 3v12" /></>} />
);
export const RefreshIcon = (p) => (
  <Icon {...p} path={<><path d="M23 4v6h-6" /><path d="M1 20v-6h6" /><path d="M3.5 9a9 9 0 0114.9-3.4L23 10M1 14l4.6 4.4A9 9 0 0020.5 15" /></>} />
);
export const SendIcon = (p) => <Icon {...p} path={<><path d="M22 2L11 13" /><path d="M22 2l-7 20-4-9-9-4 20-7z" /></>} />;
export const StopIcon = (p) => <Icon {...p} path={<rect x="6" y="6" width="12" height="12" rx="1.5" />} />;
export const SunIcon = (p) => (
  <Icon {...p} path={<><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>} />
);
export const MoonIcon = (p) => <Icon {...p} path={<path d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z" />} />;
export const ArchiveIcon = (p) => (
  <Icon {...p} path={<><rect x="3" y="4" width="18" height="4" rx="1" /><path d="M5 8v11a1 1 0 001 1h12a1 1 0 001-1V8" /><path d="M10 12h4" /></>} />
);
export const ChevronIcon = (p) => <Icon {...p} path={<path d="M6 9l6 6 6-6" />} />;
export const CopyIcon = (p) => (
  <Icon {...p} path={<><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" /></>} />
);
export const DownloadIcon = (p) => (
  <Icon {...p} path={<><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" /><path d="M7 10l5 5 5-5" /><path d="M12 15V3" /></>} />
);
export const CheckIcon = (p) => <Icon {...p} path={<path d="M20 6L9 17l-5-5" />} />;
export const AlertIcon = (p) => (
  <Icon {...p} path={<><circle cx="12" cy="12" r="9" /><path d="M12 8v4M12 16h.01" /></>} />
);
export const BookIcon = (p) => (
  <Icon {...p} path={<><path d="M4 19.5A2.5 2.5 0 016.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z" /></>} />
);
export const MenuIcon = (p) => <Icon {...p} path={<path d="M3 6h18M3 12h18M3 18h18" />} />;
export const ChartIcon = (p) => (
  <Icon {...p} path={<><path d="M3 3v18h18" /><rect x="7" y="10" width="3" height="7" rx="1" /><rect x="13" y="6" width="3" height="11" rx="1" /></>} />
);
