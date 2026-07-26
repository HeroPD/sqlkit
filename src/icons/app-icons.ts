// The app's own mark, inline so a component can size and place it like any other
// SVG. Distinct from activity-icons.ts, whose keys are activity-view ids.
//
// Two copies of this artwork cannot import from here and must be updated with it:
// public/favicon.svg (index.html loads it as a file) and build/icon.png /
// icon.ico / icon.icns (electron-builder reads raster files).
export const APP_ICONS: Record<string, string> = {
  appicon: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" aria-hidden="true" focusable="false">
            <rect x="0" y="0" width="64" height="64" rx="13.5" fill="#13161d"/>
            <rect x="12" y="14.5" width="36" height="10" rx="4.5" fill="#e6eef5"/>
            <rect x="16" y="27.5" width="36" height="10" rx="4.5" fill="#47a8e8"/>
            <rect x="12" y="40.5" width="36" height="10" rx="4.5" fill="#e6eef5"/>
          </svg>`,
}
